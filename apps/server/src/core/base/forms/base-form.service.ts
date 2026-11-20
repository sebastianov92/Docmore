import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { BaseFormRepo, FormRow } from '@docmost/db/repos/base/base-form.repo';
import { BasePropertyRepo } from '@docmost/db/repos/base/base-property.repo';
import { BaseRepo } from '@docmost/db/repos/base/base.repo';
import { BaseProperty } from '@docmost/db/types/entity.types';
import { BaseRowService } from '../services/base-row.service';
import { validateCellValue, BasePropertyTypeValue, parseLocationText } from '../base.schemas';
import { basePropertyIdSchema } from '../base-ids';
import { CreateFormDto, UpdateFormDto } from '../dto/form.dto';
import { FORM_CONDITION_OPS, visibleFieldIds } from './form-logic';

// Property types a stranger can fill in.
const FORM_FIELD_TYPES = new Set(['text', 'longText', 'number', 'select', 'status', 'multiSelect', 'date', 'checkbox', 'url', 'email', 'phone', 'location']);

const fieldSchema = z.object({
  propertyId: basePropertyIdSchema,
  required: z.boolean().optional(),
  label: z.string().trim().max(120).optional(),
  help: z.string().trim().max(500).optional(),
  // shown only when another field's answer matches
  showIf: z
    .object({
      propertyId: basePropertyIdSchema,
      op: z.enum(FORM_CONDITION_OPS as [string, ...string[]]),
      value: z.unknown().optional(),
    })
    .nullable()
    .optional(),
});
const fieldsSchema = z.array(fieldSchema).min(1).max(40);
export type FormField = z.infer<typeof fieldSchema>;

const RATE_WINDOW_MS = 10 * 60_000;
const RATE_LIMIT = 20;

// Public forms: a token link where anyone drops a row into the base.
@Injectable()
export class BaseFormService {
  // token:ip -> submission times inside the window
  private readonly recent = new Map<string, number[]>();

  constructor(
    private readonly repo: BaseFormRepo,
    private readonly basePropertyRepo: BasePropertyRepo,
    private readonly baseRepo: BaseRepo,
    private readonly baseRowService: BaseRowService,
  ) {}

  list(pageId: string, workspaceId: string) {
    return this.repo.findByPage(pageId, workspaceId);
  }

  async create(dto: CreateFormDto, workspaceId: string, userId: string) {
    const fields = await this.parseFields(dto.fields, dto.pageId);
    return this.repo.insert({
      pageId: dto.pageId,
      workspaceId,
      token: randomBytes(18).toString('base64url'),
      name: dto.name,
      description: dto.description ?? null,
      fields,
      submitLabel: dto.submitLabel ?? null,
      thanksText: dto.thanksText ?? null,
      enabled: dto.enabled ?? false,
      creatorId: userId,
    });
  }

  async update(dto: UpdateFormDto, workspaceId: string) {
    const current = await this.repo.findById(dto.formId, workspaceId);
    if (!current || current.pageId !== dto.pageId) throw new NotFoundException('Form not found');
    const fields = dto.fields ? await this.parseFields(dto.fields, dto.pageId) : undefined;
    return this.repo.update(dto.formId, {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.description !== undefined && { description: dto.description }),
      ...(fields && { fields }),
      ...(dto.submitLabel !== undefined && { submitLabel: dto.submitLabel }),
      ...(dto.thanksText !== undefined && { thanksText: dto.thanksText }),
      ...(dto.enabled !== undefined && { enabled: dto.enabled }),
    });
  }

  async delete(formId: string, pageId: string, workspaceId: string) {
    const current = await this.repo.findById(formId, workspaceId);
    if (!current || current.pageId !== pageId) throw new NotFoundException('Form not found');
    await this.repo.delete(formId);
  }

  // What the public page needs: the fields with their types and choices.
  async publicInfo(token: string, workspaceId: string) {
    const form = await this.repo.findByToken(token, workspaceId);
    if (!form || !form.enabled) throw new NotFoundException('Form not found');
    const base = await this.baseRepo.findById(form.pageId);
    const properties = await this.basePropertyRepo.findByPageId(form.pageId);
    const fields = (form.fields as FormField[])
      .map((f) => {
        const p = properties.find((x) => x.id === f.propertyId);
        if (!p || !this.fieldAllowed(p)) return null;
        const opts = (p.typeOptions ?? {}) as any;
        return {
          propertyId: p.id,
          name: f.label || p.name,
          help: f.help ?? null,
          type: p.type,
          required: Boolean(f.required),
          showIf: f.showIf ?? null,
          typeOptions:
            p.type === 'select' || p.type === 'status' || p.type === 'multiSelect'
              ? { choices: (opts.choices ?? []).map((c: any) => ({ id: c.id, name: c.name, color: c.color })), choiceOrder: opts.choiceOrder ?? [] }
              : p.type === 'number'
                ? { format: opts.format ?? 'plain' }
                : {},
        };
      })
      .filter(Boolean);
    return {
      id: form.id,
      name: form.name,
      description: form.description,
      submitLabel: form.submitLabel,
      thanksText: form.thanksText,
      baseTitle: base?.title ?? '',
      fields,
    };
  }

  async submit(token: string, cells: Record<string, unknown>, honeypot: string | undefined, ip: string, workspaceId: string) {
    const form = await this.repo.findByToken(token, workspaceId);
    if (!form || !form.enabled) throw new NotFoundException('Form not found');
    if (honeypot && honeypot.trim() !== '') throw new BadRequestException('Rejected');
    this.rateLimit(`${token}:${ip}`);
    const properties = await this.basePropertyRepo.findByPageId(form.pageId);
    const out: Record<string, unknown> = {};
    const shown = visibleFieldIds(form.fields as FormField[], cells ?? {});
    for (const field of form.fields as FormField[]) {
      const p = properties.find((x) => x.id === field.propertyId);
      if (!p || !this.fieldAllowed(p)) continue;
      // a hidden field neither counts as required nor keeps what it sent
      if (!shown.has(field.propertyId)) continue;
      let value = cells?.[p.id];
      if (value === '' || value === undefined) value = null;
      if (value === null) {
        if (field.required) throw new BadRequestException(`${field.label || p.name} is required`);
        continue;
      }
      if (p.type === 'number' && typeof value === 'string') value = Number(value);
      if (p.type === 'multiSelect' && typeof value === 'string') value = [value];
      if (p.type === 'location' && typeof value === 'string') value = parseLocationText(value);
      const result = validateCellValue(p.type as BasePropertyTypeValue, value);
      if (!result.success) throw new BadRequestException(`${field.label || p.name}: invalid value`);
      out[p.id] = result.data;
    }
    const row = await this.baseRowService.create(null, workspaceId, { pageId: form.pageId, cells: out }, { formId: form.id });
    await this.repo.countSubmission(form.id);
    return { id: row.id, thanksText: form.thanksText };
  }

  private fieldAllowed(p: BaseProperty): boolean {
    return FORM_FIELD_TYPES.has(p.type) && ((p as any).restrictedTo ?? 'all') === 'all';
  }

  private async parseFields(input: unknown, pageId: string): Promise<FormField[]> {
    const parsed = fieldsSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException({ message: 'Invalid form fields', errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    const ids = new Set(parsed.data.map((f) => f.propertyId));
    for (const f of parsed.data) {
      if (f.showIf && (f.showIf.propertyId === f.propertyId || !ids.has(f.showIf.propertyId))) {
        throw new BadRequestException('A condition must point at another field of this form');
      }
    }
    const properties = await this.basePropertyRepo.findByPageId(pageId);
    for (const f of parsed.data) {
      const p = properties.find((x) => x.id === f.propertyId);
      if (!p) throw new BadRequestException('Unknown property in form');
      if (!FORM_FIELD_TYPES.has(p.type)) throw new BadRequestException(`${p.name} cannot be a form field`);
      if (((p as any).restrictedTo ?? 'all') !== 'all') throw new ForbiddenException(`${p.name} is a restricted column`);
    }
    return parsed.data;
  }

  private rateLimit(key: string): void {
    const now = Date.now();
    const times = (this.recent.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (times.length >= RATE_LIMIT) throw new HttpException('Too many submissions, try later', HttpStatus.TOO_MANY_REQUESTS);
    times.push(now);
    this.recent.set(key, times);
    if (this.recent.size > 5000) {
      for (const [k, v] of this.recent) if (v.every((t) => now - t >= RATE_WINDOW_MS)) this.recent.delete(k);
    }
  }
}

export type { FormRow };

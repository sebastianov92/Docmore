import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { AiAgentService } from './ai-agent.service';

const MINUTE_MS = 60_000;

// The clock of the scheduled agents: once a minute it queues the ones whose
// time has come.
@Injectable()
export class AiAgentScheduler {
  private readonly logger = new Logger(AiAgentScheduler.name);
  private running = false;

  constructor(private readonly agents: AiAgentService) {}

  @Interval('ai-agents-tick', MINUTE_MS)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const queued = await this.agents.tick();
      if (queued) this.logger.log(`Scheduled agents: ${queued} queued`);
    } catch (err: any) {
      this.logger.warn(`Scheduled agents tick failed: ${err?.message}`);
    } finally {
      this.running = false;
    }
  }
}

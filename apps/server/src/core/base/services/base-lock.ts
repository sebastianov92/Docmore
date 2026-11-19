import { ForbiddenException } from '@nestjs/common';

// A locked base keeps its properties and views as they are; rows still
// change. Editors toggle it from the toolbar.
export function assertBaseUnlocked(base: { baseLocked?: boolean | null }) {
  if (base?.baseLocked) {
    throw new ForbiddenException(
      'This base is locked: its properties and views cannot change',
    );
  }
}

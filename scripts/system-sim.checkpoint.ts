import fs from 'fs';

export type CheckpointData<TState> = {
  version: number;
  lastCompletedStep: number;
  lastCompletedLabel: string;
  updatedAt: string;
  state: TState;
};

export const readCheckpoint = <TState>(
  filePath: string,
  reset: boolean,
  enabled: boolean,
): CheckpointData<TState> | null => {
  if (!enabled) {
    return null;
  }
  if (reset && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return null;
  }
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as CheckpointData<TState>;
  } catch {
    return null;
  }
};

export const saveCheckpoint = <TState>(
  filePath: string,
  data: CheckpointData<TState>,
  enabled: boolean,
) => {
  if (!enabled) {
    return;
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
};

export const clearCheckpoint = (
  filePath: string,
  enabled: boolean,
  keep: boolean,
) => {
  if (!enabled || keep) {
    return;
  }
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
};

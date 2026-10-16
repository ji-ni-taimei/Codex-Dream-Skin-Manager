import type { ConfirmationCopy, ConfirmedLibraryCommand, ManagerError, RecoveryPage, ThemeCreateCommand, ThemeEditCommand, ThemePackageCommand, ThemeRef } from "../../contracts/manager.mjs";
import type { SourceSnapshot, SnapshotFile } from "../source-snapshots.mjs";

export interface LibraryOutcome {
  libraryChanged: boolean | null;
  resultTheme: ThemeRef | null;
  resultRevision: string | null;
  error: ManagerError | null;
  disposition?: "created" | "duplicate" | null;
  deleted?: boolean | null; cleanupPending?: boolean | null; recoveryCompleted?: boolean;
}
export interface LibraryChallenge { fingerprint: string; theme: ThemeRef; revision: string; reason: string; impact: string; copy?: ConfirmationCopy }
export interface LibraryPort {
  edit(command: ThemeEditCommand): Promise<LibraryOutcome>;
  create(command: ThemeCreateCommand, source: SourceSnapshot): Promise<LibraryOutcome>;
  importPackage(command: ThemePackageCommand, source: SnapshotFile): Promise<LibraryOutcome>;
  propose(command: ConfirmedLibraryCommand): Promise<LibraryChallenge>;
  executeConfirmed(command: ConfirmedLibraryCommand, fingerprint: string): Promise<LibraryOutcome>;
  recoveries(): Promise<RecoveryPage>;
  receipt(id: string, method?: string, expectedRevision?: string): Promise<LibraryOutcome | null>;
}

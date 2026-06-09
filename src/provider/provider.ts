export interface Provider {
  checkDeps(): Promise<void>;
  findNext(signal: AbortSignal): Promise<string>;
  findResumable(signal: AbortSignal): Promise<string>;
  fetchTicket(id: string, worktree: string, mode: string, signal: AbortSignal): Promise<void>;
  markInProgress(id: string, signal: AbortSignal): Promise<void>;
  markNeedsInput(id: string, comment: string, signal: AbortSignal): Promise<void>;
  markNeedsReview(id: string, signal: AbortSignal): Promise<void>;
  markSpecApproved(id: string, signal: AbortSignal): Promise<void>;
  isComplete(id: string, signal: AbortSignal): Promise<boolean>;
  worktreeName(id: string, signal: AbortSignal): Promise<string>;
}

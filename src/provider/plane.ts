import * as fs from 'fs';
import * as path from 'path';
import type { Config } from '../config';
import type { Provider } from './provider';

interface PlaneIssue {
  id: string;
  sequence_id: number;
  name: string;
  description_stripped: string;
  priority: string;
  state: string;
  created_at: string;
  external_id: string;
}

interface PlaneListResponse {
  results: PlaneIssue[];
}

const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

export class PlaneProvider implements Provider {
  private cfg: Config;
  private apiKey = '';

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  async checkDeps(): Promise<void> {
    if (!this.cfg.planeApiKey) {
      throw new Error('PLANE_API_KEY is required but not set');
    }
    this.apiKey = this.cfg.planeApiKey;
  }

  private async apiRequest(method: string, urlPath: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const { baseUrl, workspaceSlug } = this.cfg.plane;
    const url = `${baseUrl}/api/v1/workspaces/${workspaceSlug}${urlPath}`;
    const headers: Record<string, string> = { 'x-api-key': this.apiKey };
    let bodyStr: string | undefined;
    if (body !== undefined) {
      bodyStr = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    const resp = await fetch(url, { method, headers, body: bodyStr, signal });
    const text = await resp.text();
    return JSON.parse(text);
  }

  private async getIssue(id: string, signal: AbortSignal): Promise<PlaneIssue> {
    const { projectId } = this.cfg.plane;
    return this.apiRequest('GET', `/projects/${projectId}/issues/${id}/`, undefined, signal) as Promise<PlaneIssue>;
  }

  private async listIssues(signal: AbortSignal): Promise<PlaneIssue[]> {
    const { projectId } = this.cfg.plane;
    const data = await this.apiRequest('GET', `/projects/${projectId}/issues/?per_page=100`, undefined, signal) as PlaneListResponse;
    return data.results;
  }

  private async patchIssue(id: string, patch: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    const { projectId } = this.cfg.plane;
    await this.apiRequest('PATCH', `/projects/${projectId}/issues/${id}/`, patch, signal);
  }

  private async setState(id: string, stateId: string, signal: AbortSignal): Promise<void> {
    await this.patchIssue(id, { state: stateId }, signal);
  }

  async findNext(signal: AbortSignal): Promise<string> {
    const issues = await this.listIssues(signal);
    const { stateSpecApproved } = this.cfg.plane;

    const eligible = issues.filter(
      (issue) => issue.state === stateSpecApproved && PRIORITY_ORDER[issue.priority] !== undefined
    );
    if (eligible.length === 0) return '';

    eligible.sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority];
      const pb = PRIORITY_ORDER[b.priority];
      if (pa !== pb) return pa - pb;
      return a.created_at < b.created_at ? -1 : 1;
    });

    return eligible[0].id;
  }

  async findResumable(signal: AbortSignal): Promise<string> {
    const issues = await this.listIssues(signal);
    const { stateNeedsInput, projectId } = this.cfg.plane;

    for (const issue of issues) {
      if (issue.state !== stateNeedsInput) continue;
      try {
        const data = await this.apiRequest(
          'GET',
          `/projects/${projectId}/issues/${issue.id}/comments/?per_page=50`,
          undefined,
          signal
        ) as { results: unknown[] };
        if (data.results.length >= 2) return issue.id;
      } catch {
        // skip issues we can't fetch comments for
      }
    }
    return '';
  }

  async fetchTicket(id: string, worktree: string, mode: string, signal: AbortSignal): Promise<void> {
    const issue = await this.getIssue(id, signal);
    const { projectId } = this.cfg.plane;

    let content = `# ${issue.name}\n`;
    content += `Ticket ID: ${issue.id}\n`;
    content += `Sequence: #${issue.sequence_id}\n`;
    if (issue.external_id) content += `GitHub Issue: #${issue.external_id}\n`;
    content += `Priority: ${issue.priority}\n\n`;
    content += issue.description_stripped || '(no description)';

    if (mode === 'needs-input') {
      content += '\n\n---\n## Human replies\n';
      try {
        const data = await this.apiRequest(
          'GET',
          `/projects/${projectId}/issues/${id}/comments/?per_page=50`,
          undefined,
          signal
        ) as { results: Array<{ comment_stripped: string }> };
        for (const c of data.results) {
          content += c.comment_stripped + '\n\n';
        }
      } catch {
        // best-effort; leave section empty if fetch fails
      }
    }

    fs.writeFileSync(path.join(worktree, 'TICKET.md'), content, 'utf8');
  }

  async markInProgress(id: string, signal: AbortSignal): Promise<void> {
    await this.setState(id, this.cfg.plane.stateInProgress, signal);
  }

  async markNeedsInput(id: string, comment: string, signal: AbortSignal): Promise<void> {
    if (comment) {
      const { projectId } = this.cfg.plane;
      try {
        await this.apiRequest(
          'POST',
          `/projects/${projectId}/issues/${id}/comments/`,
          { comment_html: `<p>${comment}</p>` },
          signal
        );
      } catch {
        // best-effort
      }
    }
    await this.setState(id, this.cfg.plane.stateNeedsInput, signal);
  }

  async markNeedsReview(id: string, signal: AbortSignal): Promise<void> {
    await this.setState(id, this.cfg.plane.stateInReview, signal);
  }

  async markSpecApproved(id: string, signal: AbortSignal): Promise<void> {
    await this.setState(id, this.cfg.plane.stateSpecApproved, signal);
  }

  async isComplete(id: string, signal: AbortSignal): Promise<boolean> {
    const issue = await this.getIssue(id, signal);
    return issue.state === this.cfg.plane.stateInReview;
  }

  async worktreeName(id: string, signal: AbortSignal): Promise<string> {
    try {
      const issue = await this.getIssue(id, signal);
      if (issue.sequence_id > 0) return String(issue.sequence_id);
    } catch {
      // fall back to id
    }
    return id;
  }
}

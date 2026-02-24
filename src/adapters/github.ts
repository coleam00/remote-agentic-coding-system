/**
 * GitHub platform adapter using Octokit REST API and Webhooks
 * Handles issue and PR comments with @mention detection
 */
import { Octokit } from '@octokit/rest';
import { createHmac } from 'crypto';
import { IPlatformAdapter } from '../types';
import { handleMessage } from '../orchestrator/orchestrator';
import * as db from '../db/conversations';
import * as codebaseDb from '../db/codebases';
import * as sessionDb from '../db/sessions';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readdir, access } from 'fs/promises';
import { join } from 'path';

const execAsync = promisify(exec);

interface WebhookEvent {
  action: string;
  issue?: {
    number: number;
    title: string;
    body: string | null;
    user: { login: string };
    labels: { name: string }[];
    state: string;
  };
  pull_request?: {
    number: number;
    title: string;
    body: string | null;
    user: { login: string };
    state: string;
    changed_files?: number;
    additions?: number;
    deletions?: number;
  };
  comment?: {
    body: string;
    user: { login: string };
  };
  repository: {
    owner: { login: string };
    name: string;
    full_name: string;
    html_url: string;
    default_branch: string;
  };
  sender: { login: string };
}

export class GitHubAdapter implements IPlatformAdapter {
  private octokit: Octokit;
  private webhookSecret: string;

  constructor(token: string, webhookSecret: string) {
    this.octokit = new Octokit({ auth: token });
    this.webhookSecret = webhookSecret;
    console.log('[GitHub] Adapter initialized with secret:', webhookSecret.substring(0, 8) + '...');
  }

  /**
   * Send a message to a GitHub issue or PR
   */
  async sendMessage(conversationId: string, message: string): Promise<void> {
    const parsed = this.parseConversationId(conversationId);
    if (!parsed) {
      console.error('[GitHub] Invalid conversationId:', conversationId);
      return;
    }

    try {
      await this.octokit.rest.issues.createComment({
        owner: parsed.owner,
        repo: parsed.repo,
        issue_number: parsed.number,
        body: message,
      });
      console.log(`[GitHub] Comment posted to ${conversationId}`);
    } catch (error) {
      console.error('[GitHub] Failed to post comment:', { error, conversationId });
    }
  }

  /**
   * Get streaming mode (always batch for GitHub to avoid comment spam)
   */
  getStreamingMode(): 'batch' {
    return 'batch';
  }

  /**
   * Get platform type
   */
  getPlatformType(): string {
    return 'github';
  }

  /**
   * Start the adapter (no-op for webhook-based adapter)
   */
  async start(): Promise<void> {
    console.log('[GitHub] Webhook adapter ready');
  }

  /**
   * Stop the adapter (no-op for webhook-based adapter)
   */
  stop(): void {
    console.log('[GitHub] Adapter stopped');
  }

  /**
   * Verify webhook signature using HMAC SHA-256
   */
  private verifySignature(payload: string, signature: string): boolean {
    try {
      const hmac = createHmac('sha256', this.webhookSecret);
      const digest = 'sha256=' + hmac.update(payload).digest('hex');
      const isValid = digest === signature;

      if (!isValid) {
        console.error('[GitHub] Signature mismatch:', {
          received: signature.substring(0, 15) + '...',
          computed: digest.substring(0, 15) + '...',
          secretLength: this.webhookSecret.length,
        });
      }

      return isValid;
    } catch (error) {
      console.error('[GitHub] Signature verification error:', error);
      return false;
    }
  }

  /**
   * Parse webhook event and extract relevant data
   */
  private parseEvent(event: WebhookEvent): {
    owner: string;
    repo: string;
    number: number;
    comment: string;
    eventType: 'issue' | 'issue_comment' | 'pull_request';
    issue?: WebhookEvent['issue'];
    pullRequest?: WebhookEvent['pull_request'];
  } | null {
    const owner = event.repository.owner.login;
    const repo = event.repository.name;

    // issue_comment (covers both issues and PRs)
    if (event.comment) {
      const number = event.issue?.number || event.pull_request?.number;
      if (!number) return null;
      return {
        owner,
        repo,
        number,
        comment: event.comment.body,
        eventType: 'issue_comment',
        issue: event.issue,
        pullRequest: event.pull_request,
      };
    }

    // issues.opened
    if (event.issue && event.action === 'opened') {
      return {
        owner,
        repo,
        number: event.issue.number,
        comment: event.issue.body || '',
        eventType: 'issue',
        issue: event.issue,
      };
    }

    // pull_request.opened
    if (event.pull_request && event.action === 'opened') {
      return {
        owner,
        repo,
        number: event.pull_request.number,
        comment: event.pull_request.body || '',
        eventType: 'pull_request',
        pullRequest: event.pull_request,
      };
    }

    return null;
  }

  /**
   * Check if text contains @remote-agent mention
   */
  private hasMention(text: string): boolean {
    return /@remote-agent[\s,:;]/.test(text) || text.trim() === '@remote-agent';
  }

  /**
   * Strip @remote-agent mention from text
   */
  private stripMention(text: string): string {
    return text.replace(/@remote-agent[\s,:;]+/g, '').trim();
  }

  /**
   * Build conversationId from owner, repo, and number
   */
  private buildConversationId(owner: string, repo: string, number: number): string {
    return `${owner}/${repo}#${number}`;
  }

  /**
   * Parse conversationId into owner, repo, and number
   */
  private parseConversationId(
    conversationId: string
  ): { owner: string; repo: string; number: number } | null {
    const regex = /^([^/]+)\/([^#]+)#(\d+)$/;
    const match = regex.exec(conversationId);
    if (!match) return null;
    return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) };
  }

  /**
   * Ensure repository is cloned and ready
   * For new conversations: clone or sync
   * For existing conversations: skip
   */
  private async ensureRepoReady(
    owner: string,
    repo: string,
    defaultBranch: string,
    repoPath: string,
    shouldSync: boolean
  ): Promise<void> {
    try {
      await access(repoPath);
      if (shouldSync) {
        console.log('[GitHub] Syncing repository');
        await execAsync(
          `cd ${repoPath} && git fetch origin && git reset --hard origin/${defaultBranch}`
        );
      }
    } catch {
      console.log(`[GitHub] Cloning repository to ${repoPath}`);
      const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      const repoUrl = `https://github.com/${owner}/${repo}.git`;
      let cloneCommand = `git clone ${repoUrl} ${repoPath}`;

      if (ghToken) {
        const authenticatedUrl = `https://${ghToken}@github.com/${owner}/${repo}.git`;
        cloneCommand = `git clone ${authenticatedUrl} ${repoPath}`;
      }

      await execAsync(cloneCommand);
      await execAsync(`git config --global --add safe.directory '${repoPath}'`);
    }
  }

  /**
   * Auto-detect and load commands from .claude/commands or .agents/commands
   */
  private async autoDetectAndLoadCommands(repoPath: string, codebaseId: string): Promise<void> {
    const commandFolders = ['.claude/commands', '.agents/commands'];

    for (const folder of commandFolders) {
      try {
        const fullPath = join(repoPath, folder);
        await access(fullPath);

        const files = (await readdir(fullPath)).filter(f => f.endsWith('.md'));
        if (files.length === 0) continue;

        const commands = await codebaseDb.getCodebaseCommands(codebaseId);
        files.forEach(file => {
          commands[file.replace('.md', '')] = {
            path: join(folder, file),
            description: `From ${folder}`,
          };
        });

        await codebaseDb.updateCodebaseCommands(codebaseId, commands);
        console.log(`[GitHub] Loaded ${files.length} commands from ${folder}`);
        return;
      } catch {
        continue;
      }
    }
  }

  /**
   * Get or create codebase for repository
   * Returns: codebase record, path to use, and whether it's new
   */
  private async getOrCreateCodebaseForRepo(
    owner: string,
    repo: string
  ): Promise<{ codebase: { id: string; name: string }; repoPath: string; isNew: boolean }> {
    // Try both with and without .git suffix to match existing clones
    const repoUrlNoGit = `https://github.com/${owner}/${repo}`;
    const repoUrlWithGit = `${repoUrlNoGit}.git`;

    let existing = await codebaseDb.findCodebaseByRepoUrl(repoUrlNoGit);
    if (!existing) {
      existing = await codebaseDb.findCodebaseByRepoUrl(repoUrlWithGit);
    }

    if (existing) {
      console.log(`[GitHub] Using existing codebase: ${existing.name} at ${existing.default_cwd}`);
      return { codebase: existing, repoPath: existing.default_cwd, isNew: false };
    }

    // Use just the repo name (not owner-repo) to match /clone behavior
    const repoPath = `/workspace/${repo}`;
    const codebase = await codebaseDb.createCodebase({
      name: repo,
      repository_url: repoUrlNoGit, // Store without .git for consistency
      default_cwd: repoPath,
    });

    console.log(`[GitHub] Created new codebase: ${codebase.name} at ${repoPath}`);
    return { codebase, repoPath, isNew: true };
  }

  /**
   * Fetch previous comments from an issue for context
   * Filters out bot acknowledgments to keep context relevant
   */
  private async fetchIssueComments(owner: string, repo: string, issueNumber: number): Promise<string> {
    try {
      const { data: comments } = await this.octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: issueNumber,
        per_page: 20,
      });

      if (comments.length === 0) return '';

      // Filter out bot acknowledgments and format comments
      const relevantComments = comments
        .filter(c => !c.body?.includes('Working on this') && !c.body?.includes('An error occurred'))
        .slice(-10) // Keep last 10 relevant comments
        .map(c => `**${c.user?.login}**: ${c.body}`)
        .join('\n\n');

      return relevantComments ? `\n\nPrevious Comments:\n${relevantComments}` : '';
    } catch (e) {
      console.warn('[GitHub] Could not fetch comments:', e);
      return '';
    }
  }

  /**
   * Build context-rich message for issue
   * Includes previous comments for full conversation context
   */
  private async buildIssueContext(
    owner: string,
    repo: string,
    issue: WebhookEvent['issue'],
    userComment: string
  ): Promise<string> {
    if (!issue) return userComment;
    const labels = issue.labels.map(l => l.name).join(', ');
    const previousComments = await this.fetchIssueComments(owner, repo, issue.number);

    return `[GitHub Issue Context]
Issue #${issue.number}: "${issue.title}"
Author: ${issue.user.login}
Labels: ${labels}
Status: ${issue.state}

Description:
${issue.body}
${previousComments}

---

${userComment}`;
  }

  /**
   * Build context-rich message for pull request
   */
  private buildPRContext(pr: WebhookEvent['pull_request'], userComment: string): string {
    if (!pr) return userComment;
    const stats = pr.changed_files
      ? `Changed files: ${pr.changed_files} (+${pr.additions}, -${pr.deletions})`
      : '';

    return `[GitHub Pull Request Context]
PR #${pr.number}: "${pr.title}"
Author: ${pr.user.login}
Status: ${pr.state}
${stats}

Description:
${pr.body}

Use 'gh pr diff ${pr.number}' to see detailed changes.

---

${userComment}`;
  }

  /**
   * Handle incoming webhook event
   */
  async handleWebhook(
    payload: string,
    signature: string
  ): Promise<void> {
    // 1. Verify signature
    if (!this.verifySignature(payload, signature)) {
      console.error('[GitHub] Invalid webhook signature');
      return;
    }

    // 2. Parse event
    const event: WebhookEvent = JSON.parse(payload);
    const parsed = this.parseEvent(event);
    if (!parsed) return;

    const { owner, repo, number, comment, eventType, issue, pullRequest } = parsed;

    // 3. Check @mention
    if (!this.hasMention(comment)) return;

    console.log(`[GitHub] Processing ${eventType}: ${owner}/${repo}#${number}`);

    // 4. Build conversationId
    const conversationId = this.buildConversationId(owner, repo, number);

    // 5. Check if new conversation
    const existingConv = await db.getOrCreateConversation('github', conversationId);
    const isNewConversation = !existingConv.codebase_id;

    // 6. Get/create codebase (checks for existing first!)
    const { codebase, repoPath, isNew: isNewCodebase } = await this.getOrCreateCodebaseForRepo(
      owner,
      repo
    );

    // 7. Get default branch
    const { data: repoData } = await this.octokit.rest.repos.get({ owner, repo });
    const defaultBranch = repoData.default_branch;

    // 8. Ensure repo ready (clone if needed, sync if new conversation)
    await this.ensureRepoReady(owner, repo, defaultBranch, repoPath, isNewConversation);

    // 9. Auto-load commands if new codebase
    if (isNewCodebase) {
      await this.autoDetectAndLoadCommands(repoPath, codebase.id);
    }

    // 10. Update conversation
    if (isNewConversation) {
      await db.updateConversation(existingConv.id, {
        codebase_id: codebase.id,
        cwd: repoPath,
      });
    }

    // 11. Build message with context
    const strippedComment = this.stripMention(comment);
    let finalMessage = strippedComment;
    let contextToAppend: string | undefined;

    // IMPORTANT: Slash commands must be processed deterministically (not by AI)
    // Extract only the first line if it's a slash command
    const isSlashCommand = strippedComment.trim().startsWith('/');
    const isCommandInvoke = strippedComment.trim().startsWith('/command-invoke');

    if (isSlashCommand) {
      // For slash commands, use only the first line to avoid mixing commands with instructions
      const firstLine = strippedComment.split('\n')[0].trim();
      finalMessage = firstLine;
      console.log(`[GitHub] Processing slash command: ${firstLine}`);

      // For /command-invoke, pass just the issue/PR number (not full description)
      // This avoids tempting the AI to implement before planning
      if (isCommandInvoke) {
        const activeSession = await sessionDb.getActiveSession(existingConv.id);
        const isFirstCommandInvoke = !activeSession;

        if (isFirstCommandInvoke) {
          console.log('[GitHub] Adding issue/PR reference for first /command-invoke');
          if (eventType === 'issue' && issue) {
            contextToAppend = `GitHub Issue #${issue.number}: "${issue.title}"\nUse 'gh issue view ${issue.number}' for full details if needed.`;
          } else if (eventType === 'issue_comment' && issue) {
            contextToAppend = `GitHub Issue #${issue.number}: "${issue.title}"\nUse 'gh issue view ${issue.number}' for full details if needed.`;
          } else if (eventType === 'pull_request' && pullRequest) {
            contextToAppend = `GitHub Pull Request #${pullRequest.number}: "${pullRequest.title}"\nUse 'gh pr view ${pullRequest.number}' for full details if needed.`;
          } else if (eventType === 'issue_comment' && pullRequest) {
            contextToAppend = `GitHub Pull Request #${pullRequest.number}: "${pullRequest.title}"\nUse 'gh pr view ${pullRequest.number}' for full details if needed.`;
          }
        }
      }
    } else {
      // Always include issue/PR context, not just for new conversations
      // This helps the agent understand the full context on follow-up comments
      if (eventType === 'issue' && issue) {
        finalMessage = await this.buildIssueContext(owner, repo, issue, strippedComment);
      } else if (eventType === 'issue_comment' && issue) {
        finalMessage = await this.buildIssueContext(owner, repo, issue, strippedComment);
      } else if (eventType === 'pull_request' && pullRequest) {
        finalMessage = this.buildPRContext(pullRequest, strippedComment);
      } else if (eventType === 'issue_comment' && pullRequest) {
        finalMessage = this.buildPRContext(pullRequest, strippedComment);
      }
    }

    // 12. Route to orchestrator
    try {
      await handleMessage(this, conversationId, finalMessage, contextToAppend);
    } catch (error) {
      console.error('[GitHub] Message handling error:', error);
      await this.sendMessage(
        conversationId,
        '⚠️ An error occurred. Please try again or use /reset.'
      );
    }
  }
}

/**
 * GitHub platform adapter using Octokit REST API and Webhooks
 * Handles issue and PR comments with @mention detection
 *
 * ENHANCED: Added worktree isolation for concurrent issue handling
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
   * Verify GitHub webhook signature
   */
  private verifySignature(payload: string, signature: string): boolean {
    const hmac = createHmac('sha256', this.webhookSecret);
    const digest = 'sha256=' + hmac.update(payload).digest('hex');
    return signature === digest;
  }

  /**
   * Parse event to extract relevant data
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
    return /@remote-agent\b/i.test(text);
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
   * Get or create a git worktree for a specific issue (provides isolation)
   * This allows concurrent work on different issues without interference
   */
  private async getOrCreateWorktree(baseRepoPath: string, issueNumber: number): Promise<string> {
    const worktreePath = `${baseRepoPath}-issue-${issueNumber}`;
    const maxRetries = 3;

    try {
      await access(worktreePath);
      // Worktree exists - reset it to latest main
      console.log(`[GitHub] [Issue #${issueNumber}] Using existing worktree: ${worktreePath}`);
      await execAsync(`git -C ${worktreePath} fetch origin main 2>/dev/null || true`);
      await execAsync(`git -C ${worktreePath} checkout . 2>/dev/null || true`);
      await execAsync(`git -C ${worktreePath} clean -fd 2>/dev/null || true`);
      await execAsync(`git -C ${worktreePath} reset --hard origin/main 2>/dev/null || true`);
      return worktreePath;
    } catch {
      // Create new worktree from main with retry logic
      console.log(`[GitHub] [Issue #${issueNumber}] Creating new worktree: ${worktreePath}`);

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          // Ensure base repo exists and is ready
          await access(baseRepoPath);
          await execAsync(`git -C ${baseRepoPath} fetch origin main`);

          // Remove any stale worktree reference
          await execAsync(`git -C ${baseRepoPath} worktree prune 2>/dev/null || true`);
          await execAsync(`rm -rf ${worktreePath} 2>/dev/null || true`);

          // Create worktree
          await execAsync(`git -C ${baseRepoPath} worktree add -f ${worktreePath} origin/main`);
          console.log(`[GitHub] [Issue #${issueNumber}] Worktree created successfully`);
          return worktreePath;
        } catch (e) {
          console.warn(`[GitHub] [Issue #${issueNumber}] Worktree creation attempt ${attempt}/${maxRetries} failed: ${e}`);
          if (attempt < maxRetries) {
            // Wait before retry (exponential backoff)
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
          }
        }
      }

      console.error(`[GitHub] [Issue #${issueNumber}] Failed to create worktree after ${maxRetries} attempts, using base repo`);
      return baseRepoPath;
    }
  }

  /**
   * Cleanup a worktree for a specific issue
   */
  private async cleanupWorktree(baseRepoPath: string, issueNumber: number): Promise<void> {
    const worktreePath = `${baseRepoPath}-issue-${issueNumber}`;
    try {
      await execAsync(`git -C ${baseRepoPath} worktree remove ${worktreePath} --force 2>/dev/null || true`);
      await execAsync(`rm -rf ${worktreePath} 2>/dev/null || true`);
      console.log(`[GitHub] [Issue #${issueNumber}] Cleaned up worktree: ${worktreePath}`);
    } catch (e) {
      console.warn(`[GitHub] Could not cleanup worktree: ${e}`);
    }
  }

  /**
   * Cleanup all stale worktrees (older than 7 days)
   */
  private async cleanupStaleWorktrees(baseRepoPath: string): Promise<void> {
    try {
      const { stdout } = await execAsync(`find ${baseRepoPath}-issue-* -maxdepth 0 -mtime +7 2>/dev/null || true`);
      const stalePaths = stdout.trim().split('\n').filter(p => p);

      for (const path of stalePaths) {
        const match = path.match(/issue-(\d+)$/);
        if (match) {
          const issueNum = parseInt(match[1]);
          await this.cleanupWorktree(baseRepoPath, issueNum);
        }
      }

      if (stalePaths.length > 0) {
        console.log(`[GitHub] Cleaned up ${stalePaths.length} stale worktrees`);
      }
    } catch {
      // Ignore errors during stale cleanup
    }
  }

  /**
   * Get or create codebase for repository
   * Returns: codebase record, path to use, and whether it's new
   *
   * ENHANCED: Supports issue-specific worktrees for isolation
   */
  private async getOrCreateCodebaseForRepo(
    owner: string,
    repo: string,
    issueNumber?: number
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

      // Check if base repo actually exists on disk (may be lost after container restart)
      let baseRepoExists = false;
      try {
        await access(existing.default_cwd);
        await execAsync(`git -C ${existing.default_cwd} status`);
        baseRepoExists = true;
      } catch {
        console.log(`[GitHub] Base repo not found at ${existing.default_cwd}, will clone first`);
      }

      if (baseRepoExists) {
        // Update base repo
        try {
          await execAsync(`git -C ${existing.default_cwd} fetch origin main 2>/dev/null || true`);
        } catch (e) {
          console.warn(`[GitHub] Could not fetch latest: ${e}`);
        }

        // Use worktree for issue isolation if issue number provided
        if (issueNumber) {
          const worktreePath = await this.getOrCreateWorktree(existing.default_cwd, issueNumber);
          return { codebase: existing, repoPath: worktreePath, isNew: false };
        }

        return { codebase: existing, repoPath: existing.default_cwd, isNew: false };
      }
      // baseRepoExists is false - fall through to clone new repo
    }

    // Use just the repo name (not owner-repo) to match /clone behavior
    const repoPath = `/workspace/${repo}`;
    const codebase = existing || await codebaseDb.createCodebase({
      name: repo,
      repository_url: repoUrlNoGit, // Store without .git for consistency
      default_cwd: repoPath,
    });

    console.log(`[GitHub] Created new codebase: ${codebase.name} at ${repoPath}`);
    return { codebase, repoPath, isNew: !existing };
  }

  /**
   * Build context-rich message for issue
   */
  private buildIssueContext(issue: WebhookEvent['issue'], userComment: string): string {
    if (!issue) return userComment;
    const labels = issue.labels.map(l => l.name).join(', ');

    return `[GitHub Issue Context]
Issue #${issue.number}: "${issue.title}"
Author: ${issue.user.login}
Labels: ${labels}
Status: ${issue.state}

Description:
${issue.body}

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

    // Handle PR/issue close events - cleanup worktree
    if (event.action === 'closed') {
      const closeNumber = event.pull_request?.number || event.issue?.number;
      const closeRepo = event.repository?.name;
      if (closeNumber && closeRepo) {
        const baseRepoPath = `/workspace/${closeRepo}`;
        this.cleanupWorktree(baseRepoPath, closeNumber).catch(e =>
          console.warn(`[GitHub] Cleanup failed: ${e}`)
        );
        this.cleanupStaleWorktrees(baseRepoPath).catch(() => {});
      }
      return; // Don't process close events further
    }

    // 3. Check @mention
    if (!this.hasMention(comment)) return;

    console.log(`[GitHub] Processing ${eventType}: ${owner}/${repo}#${number}`);

    // 4. Build conversationId
    const conversationId = this.buildConversationId(owner, repo, number);

    // 5. Check if new conversation
    const existingConv = await db.getOrCreateConversation('github', conversationId);
    const isNewConversation = !existingConv.codebase_id;

    // 6. Get/create codebase with worktree isolation
    const { codebase, repoPath, isNew: isNewCodebase } = await this.getOrCreateCodebaseForRepo(
      owner,
      repo,
      number  // Pass issue/PR number for worktree isolation
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

    // 10. Update conversation - ALWAYS update cwd to ensure correct worktree is used
    await db.updateConversation(existingConv.id, {
      codebase_id: codebase.id,
      cwd: repoPath,  // Always set to current worktree path
    });

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
    } else if (isNewConversation) {
      // For non-command messages, add issue/PR context directly
      if (eventType === 'issue' && issue) {
        finalMessage = this.buildIssueContext(issue, strippedComment);
      } else if (eventType === 'issue_comment' && issue) {
        finalMessage = this.buildIssueContext(issue, strippedComment);
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

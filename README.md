# Dynamous Remote Coding Agent

Control AI coding assistants (Claude Code, Codex) remotely from Telegram, GitHub, and more. Built for developers who want to code from anywhere with persistent sessions and flexible workflows/systems.

**Quick Start:** [Core Configuration](#1-core-configuration-required) • [AI Assistant Setup](#2-ai-assistant-setup-choose-at-least-one) • [Platform Setup](#3-platform-adapter-setup-choose-at-least-one) • [Start the App](#4-start-the-application) • [Usage Guide](#usage)

## Features

- **Multi-Platform Support**: Interact via Telegram, GitHub issues/PRs, and more in the future
- **Multiple AI Assistants**: Choose between Claude Code or Codex (or both)
- **Persistent Sessions**: Sessions survive container restarts with full context preservation
- **Codebase Management**: Clone and work with any GitHub repository
- **Flexible Streaming**: Real-time or batch message delivery per platform
- **Generic Command System**: User-defined commands versioned with Git
- **Docker Ready**: Simple deployment with Docker Compose

## Prerequisites

**System Requirements:**
- Docker & Docker Compose (for deployment)
- Node.js 20+ (for local development only)

**Accounts Required:**
- GitHub account (for repository cloning via `/clone` command)
- At least one of: Claude Pro/Max subscription OR Codex account
- At least one of: Telegram account OR GitHub account (for interaction)

---

**🌐 Production Deployment:** This guide covers local development setup. To deploy remotely for 24/7 operation on a cloud VPS (DigitalOcean, AWS, Linode, etc.), see the **[Cloud Deployment Guide](docs/cloud-deployment.md)**.

---

## Setup Guide

**Get started:**
```bash
git clone https://github.com/coleam00/remote-agentic-coding-system
cd remote-agentic-coding-system
```

### 1. Core Configuration (Required)

**Create environment file:**
```bash
cp .env.example .env
```

**Set these required variables:**

| Variable | Purpose | How to Get |
|----------|---------|------------|
| `DATABASE_URL` | PostgreSQL connection | See database options below |
| `GH_TOKEN` | Repository cloning | [Generate token](https://github.com/settings/tokens) with `repo` scope |
| `GITHUB_TOKEN` | Same as `GH_TOKEN` | Use same token value |
| `PORT` | HTTP server port | Default: `3000` (optional) |
| `WORKSPACE_PATH` | Clone destination | Default: `./workspace` (optional) |

**GitHub Personal Access Token Setup:**

1. Visit [GitHub Settings > Personal Access Tokens](https://github.com/settings/tokens)
2. Click "Generate new token (classic)" → Select scope: **`repo`**
3. Copy token (starts with `ghp_...`) and set both variables:

```env
# .env
GH_TOKEN=ghp_your_token_here
GITHUB_TOKEN=ghp_your_token_here  # Same value
```

**Database Setup - Choose One:**

<details>
<summary><b>Option A: Remote PostgreSQL (Supabase, Neon)</b></summary>

Set your remote connection string:

```env
DATABASE_URL=postgresql://user:password@host:5432/dbname
```

Run migrations manually after first startup:

```bash
# Download the migration file or use psql directly
psql $DATABASE_URL < migrations/001_initial_schema.sql
```

This creates 3 tables:
- `remote_agent_codebases` - Repository metadata
- `remote_agent_conversations` - Platform conversation tracking
- `remote_agent_sessions` - AI session management

</details>

<details>
<summary><b>Option B: Local PostgreSQL (via Docker)</b></summary>

Use the `with-db` profile for automatic PostgreSQL setup:

```env
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/remote_coding_agent
```

Database will be created automatically when you start with `docker compose --profile with-db`.

If you previously started the old compose config, reset the local DB volume once with `docker compose --profile with-db down -v` before bringing it back up.

</details>

---

### 2. AI Assistant Setup (Choose At Least One)

You must configure **at least one** AI assistant. Both can be configured if desired.

<details>
<summary><b>🤖 Claude Code</b></summary>

**Recommended for Claude Pro/Max subscribers.**

**Get OAuth Token (Preferred Method):**

```bash
# Install Claude Code CLI first: https://docs.claude.com/claude-code/installation
claude setup-token

# Copy the token starting with sk-ant-oat01-...
```

**Set environment variable:**

```env
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xxxxx
```

**Alternative: API Key** (if you prefer pay-per-use credits):

1. Visit [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
2. Create a new key (starts with `sk-ant-`)
3. Set environment variable:

```env
CLAUDE_API_KEY=sk-ant-xxxxx
```

**Set as default assistant (optional):**

If you want Claude to be the default AI assistant for new conversations without codebase context, set this environment variable:

```env
DEFAULT_AI_ASSISTANT=claude
```

</details>

<details>
<summary><b>🤖 Codex</b></summary>

**Authenticate with Codex CLI:**

```bash
# Install Codex CLI first: https://docs.codex.com/installation
codex login

# Follow browser authentication flow
```

**Extract credentials from auth file:**

On Linux/Mac:
```bash
cat ~/.codex/auth.json
```

On Windows:
```cmd
type %USERPROFILE%\.codex\auth.json
```

**Set all four environment variables:**

```env
CODEX_ID_TOKEN=eyJhbGc...
CODEX_ACCESS_TOKEN=eyJhbGc...
CODEX_REFRESH_TOKEN=rt_...
CODEX_ACCOUNT_ID=6a6a7ba6-...
```

**Set as default assistant (optional):**

If you want Codex to be the default AI assistant for new conversations without codebase context, set this environment variable:

```env
DEFAULT_AI_ASSISTANT=codex
```

</details>

**How Assistant Selection Works:**
- Assistant type is set per codebase (auto-detected from `.claude/commands/` or `.codex/` folders)
- Once a conversation starts, the assistant type is locked for that conversation
- `DEFAULT_AI_ASSISTANT` (optional) is used only for new conversations without codebase context

---

### 3. Platform Adapter Setup (Choose At Least One)

You must configure **at least one** platform to interact with your AI assistant.

<details>
<summary><b>💬 Telegram</b></summary>

**Create Telegram Bot:**

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token (format: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

**Set environment variable:**

```env
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHI...
```

**Configure streaming mode (optional):**

```env
TELEGRAM_STREAMING_MODE=stream  # stream (default) | batch
```

**For streaming mode details, see [Advanced Configuration](#advanced-configuration).**

</details>

<details>
<summary><b>🐙 GitHub Webhooks</b></summary>

**Requirements:**
- GitHub repository with issues enabled
- `GITHUB_TOKEN` already set in Core Configuration above
- Public endpoint for webhooks (see ngrok setup below for local development)

**Step 1: Generate Webhook Secret**

On Linux/Mac:
```bash
openssl rand -hex 32
```

On Windows (PowerShell):
```powershell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
```

Save this secret - you'll need it for steps 3 and 4.

**Step 2: Expose Local Server (Development Only)**

<details>
<summary>Using ngrok (Free Tier)</summary>

```bash
# Install ngrok: https://ngrok.com/download
# Or: choco install ngrok (Windows)
# Or: brew install ngrok (Mac)

# Start tunnel
ngrok http 3000

# Copy the HTTPS URL (e.g., https://abc123.ngrok-free.app)
# ⚠️ Free tier URLs change on restart
```

Keep this terminal open while testing.

</details>

<details>
<summary>Using Cloudflare Tunnel (Persistent URLs)</summary>

```bash
# Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/
cloudflared tunnel --url http://localhost:3000

# Get persistent URL from Cloudflare dashboard
```

Persistent URLs survive restarts.

</details>

**For production deployments**, use your deployed server URL (no tunnel needed).

**Step 3: Configure GitHub Webhook**

Go to your repository settings:
- Navigate to: `https://github.com/owner/repo/settings/hooks`
- Click "Add webhook"
- **Note**: For multiple repositories, you'll need to add the webhook to each one individually

**Webhook Configuration:**

| Field | Value |
|-------|-------|
| **Payload URL** | Local: `https://abc123.ngrok-free.app/webhooks/github`<br>Production: `https://your-domain.com/webhooks/github` |
| **Content type** | `application/json` |
| **Secret** | Paste the secret from Step 1 |
| **SSL verification** | Enable SSL verification (recommended) |
| **Events** | Select "Let me select individual events":<br>✓ Issues<br>✓ Issue comments<br>✓ Pull requests |

Click "Add webhook" and verify it shows a green checkmark after delivery.

**Step 4: Set Environment Variables**

```env
WEBHOOK_SECRET=your_secret_from_step_1
```

**Important**: The `WEBHOOK_SECRET` must match exactly what you entered in GitHub's webhook configuration.

**Step 5: Configure Streaming (Optional)**

```env
GITHUB_STREAMING_MODE=batch  # batch (default) | stream
```

**For streaming mode details, see [Advanced Configuration](#advanced-configuration).**

**Usage:**

Interact by @mentioning `@remote-agent` in issues or PRs:

```
@remote-agent can you analyze this bug?
@remote-agent /command-invoke prime
@remote-agent review this implementation
```

**First mention behavior:**
- Automatically clones the repository to `/workspace`
- Detects and loads commands from `.claude/commands/` or `.agents/commands/`
- Injects full issue/PR context for the AI assistant

**Subsequent mentions:**
- Resumes existing conversation
- Maintains full context across comments

</details>

---

### 4. Start the Application

Choose the Docker Compose profile based on your database setup:

**Option A: With Remote PostgreSQL (Supabase, Neon, etc.)**

Starts only the app container (requires `DATABASE_URL` set to remote database in `.env`):

```bash
# Start app container
docker compose --profile external-db up -d --build

# View logs
docker compose logs -f app
```

**Option B: With Local PostgreSQL (Docker)**

Starts both the app and PostgreSQL containers:

```bash
# Start containers
docker compose --profile with-db up -d --build

# Wait for startup (watch logs)
docker compose logs -f app-with-db

# Database tables are created automatically via init script
```

**Option C: Local Development (No Docker)**

Run directly with Node.js (requires local PostgreSQL or remote `DATABASE_URL` in `.env`):

```bash
npm run dev
```

**Stop the application:**

```bash
docker compose --profile external-db down  # If using Option A
docker compose --profile with-db down      # If using Option B
```

---

## Usage

### Available Commands

Once your platform adapter is running, you can use these commands:

| Command | Description | Example |
|---------|-------------|---------|
| `/help` | Show available commands | `/help` |
| `/clone <url>` | Clone a GitHub repository | `/clone https://github.com/user/repo` |
| `/repos` | List cloned repositories | `/repos` |
| `/status` | Show conversation state | `/status` |
| `/getcwd` | Show current working directory | `/getcwd` |
| `/setcwd <path>` | Change working directory | `/setcwd /workspace/repo` |
| `/command-set <name> <path>` | Register a custom command | `/command-set analyze .claude/commands/analyze.md` |
| `/load-commands <folder>` | Bulk load commands from folder | `/load-commands .claude/commands` |
| `/command-invoke <name> [args]` | Execute custom command | `/command-invoke plan "Add dark mode"` |
| `/commands` | List registered commands | `/commands` |
| `/reset` | Clear active session | `/reset` |

### Example Workflow (Telegram)

**🚀 Initial Setup**
```
You: /clone https://github.com/anthropics/anthropic-sdk-typescript

Bot: ✅ Repository cloned successfully!

     📁 Codebase: anthropic-sdk-typescript
     📂 Path: /workspace/anthropic-sdk-typescript

     🔍 Detected .claude/commands/ folder

You: /load-commands .claude/commands

Bot: ✅ Loaded 5 commands:
     • prime - Research codebase
     • plan - Create implementation plan
     • execute - Implement feature
     • validate - Run validation
     • commit - Create git commit
```

**💬 Asking Questions**
```
You: What files are in this repo?

Bot: 📋 Let me analyze the repository structure for you...

     [Claude streams detailed analysis]
```

**🔧 Working with Commands**
```
You: /command-invoke prime

Bot: 🔍 Starting codebase research...

     [Claude analyzes codebase structure, dependencies, patterns]

You: /command-invoke plan "Add retry logic to API calls"

Bot: 📝 Creating implementation plan...

     [Claude creates detailed plan with steps]
```

**ℹ️ Checking Status**
```
You: /status

Bot: 📊 Conversation Status

     🤖 Platform: telegram
     🧠 AI Assistant: claude

     📦 Codebase: anthropic-sdk-typescript
     🔗 Repository: https://github.com/anthropics/anthropic-sdk-typescript
     📂 Working Directory: /workspace/anthropic-sdk-typescript

     🔄 Active Session: a1b2c3d4...

     📋 Registered Commands:
       • prime - Research codebase
       • plan - Create implementation plan
       • execute - Implement feature
       • validate - Run validation
       • commit - Create git commit
```

**🔄 Reset Session**
```
You: /reset

Bot: ✅ Session cleared. Starting fresh on next message.
     📦 Codebase configuration preserved.
```

### Example Workflow (GitHub)

Create an issue or comment on an existing issue/PR:

```
@your-bot-name can you help me understand the authentication flow?
```

Bot responds with analysis. Continue the conversation:

```
@your-bot-name can you create a sequence diagram for this?
```

Bot maintains context and provides the diagram.

---

## Advanced Configuration

<details>
<summary><b>Streaming Modes Explained</b></summary>

### Stream Mode

Messages are sent in real-time as the AI generates responses.

**Configuration:**
```env
TELEGRAM_STREAMING_MODE=stream
GITHUB_STREAMING_MODE=stream
```

**Pros:**
- Real-time feedback and progress indication
- More interactive and engaging
- See AI reasoning as it works

**Cons:**
- More API calls to platform
- May hit rate limits with very long responses
- Creates many messages/comments

**Best for:** Interactive chat platforms (Telegram)

### Batch Mode

Only the final summary message is sent after AI completes processing.

**Configuration:**
```env
TELEGRAM_STREAMING_MODE=batch
GITHUB_STREAMING_MODE=batch
```

**Pros:**
- Single coherent message/comment
- Fewer API calls
- No spam or clutter

**Cons:**
- No progress indication during processing
- Longer wait for first response
- Can't see intermediate steps

**Best for:** Issue trackers and async platforms (GitHub)

</details>

<details>
<summary><b>Concurrency Settings</b></summary>

Control how many conversations the system processes simultaneously:

```env
MAX_CONCURRENT_CONVERSATIONS=10  # Default: 10
```

**How it works:**
- Conversations are processed with a lock manager
- If max concurrent limit reached, new messages are queued
- Prevents resource exhaustion and API rate limits
- Each conversation maintains its own independent context

**Check current load:**
```bash
curl http://localhost:3000/health/concurrency
```

**Response:**
```json
{
  "status": "ok",
  "active": 3,
  "queued": 0,
  "maxConcurrent": 10
}
```

**Tuning guidance:**
- **Low resources**: Set to 3-5
- **Standard**: Default 10 works well
- **High resources**: Can increase to 20-30 (monitor API limits)

</details>

<details>
<summary><b>Health Check Endpoints</b></summary>

The application exposes health check endpoints for monitoring:

**Basic Health Check:**
```bash
curl http://localhost:3000/health
```
Returns: `{"status":"ok"}`

**Database Connectivity:**
```bash
curl http://localhost:3000/health/db
```
Returns: `{"status":"ok","database":"connected"}`

**Concurrency Status:**
```bash
curl http://localhost:3000/health/concurrency
```
Returns: `{"status":"ok","active":0,"queued":0,"maxConcurrent":10}`

**Use cases:**
- Docker healthcheck configuration
- Load balancer health checks
- Monitoring and alerting systems (Prometheus, Datadog, etc.)
- CI/CD deployment verification

</details>

<details>
<summary><b>Custom Command System</b></summary>

Create your own commands by adding markdown files to your codebase:

**1. Create command file:**
```bash
mkdir -p .claude/commands
cat > .claude/commands/analyze.md << 'EOF'
You are an expert code analyzer.

Analyze the following aspect of the codebase: $1

Provide:
1. Current implementation analysis
2. Potential issues or improvements
3. Best practices recommendations

Focus area: $ARGUMENTS
EOF
```

**2. Load commands:**
```
/load-commands .claude/commands
```

**3. Invoke your command:**
```
/command-invoke analyze "security vulnerabilities"
```

**Variable substitution:**
- `$1`, `$2`, `$3`, etc. - Positional arguments
- `$ARGUMENTS` - All arguments as a single string
- `$PLAN` - Previous plan from session metadata
- `$IMPLEMENTATION_SUMMARY` - Previous execution summary

Commands are version-controlled with your codebase, not stored in the database.

</details>

---

## Architecture

### System Overview

```
┌─────────────────────────────────────────────┐
│   Platform Adapters (Telegram, GitHub)     │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│            Orchestrator                     │
│   (Message Routing & Context Management)    │
└──────────────┬──────────────────────────────┘
               │
       ┌───────┴────────┐
       │                │
       ▼                ▼
┌─────────────┐  ┌──────────────────┐
│  Command    │  │  AI Assistant    │
│  Handler    │  │  Clients         │
│  (Slash)    │  │  (Claude/Codex)  │
└─────────────┘  └────────┬─────────┘
       │                  │
       └────────┬─────────┘
                ▼
┌─────────────────────────────────────────────┐
│        PostgreSQL (3 Tables)                │
│  • Codebases  • Conversations  • Sessions   │
└─────────────────────────────────────────────┘
```

### Key Design Patterns

- **Adapter Pattern**: Platform-agnostic via `IPlatformAdapter` interface
- **Strategy Pattern**: Swappable AI assistants via `IAssistantClient` interface
- **Session Persistence**: AI context survives restarts via database storage
- **Generic Commands**: User-defined markdown commands versioned with Git
- **Concurrency Control**: Lock manager prevents race conditions

### Database Schema

<details>
<summary><b>3 tables with `remote_agent_` prefix</b></summary>

1. **`remote_agent_codebases`** - Repository metadata
   - Commands stored as JSONB: `{command_name: {path, description}}`
   - AI assistant type per codebase
   - Default working directory

2. **`remote_agent_conversations`** - Platform conversation tracking
   - Platform type + conversation ID (unique constraint)
   - Linked to codebase via foreign key
   - AI assistant type locked at creation

3. **`remote_agent_sessions`** - AI session management
   - Active session flag (one per conversation)
   - Session ID for resume capability
   - Metadata JSONB for command context

</details>

---

## Troubleshooting

### Bot Not Responding

**Check if application is running:**
```bash
docker compose ps
# Should show 'app' or 'app-with-db' with state 'Up'
```

**Check application logs:**
```bash
docker compose logs -f app          # If using --profile external-db
docker compose logs -f app-with-db  # If using --profile with-db
```

**Verify bot token:**
```bash
# In your .env file
cat .env | grep TELEGRAM_BOT_TOKEN
```

**Test with health check:**
```bash
curl http://localhost:3000/health
# Expected: {"status":"ok"}
```

### Database Connection Errors

**Check database health:**
```bash
curl http://localhost:3000/health/db
# Expected: {"status":"ok","database":"connected"}
```

**For local PostgreSQL (`with-db` profile):**
```bash
# Check if postgres container is running
docker compose ps postgres

# Check postgres logs
docker compose logs -f postgres

# Test direct connection
docker compose exec postgres psql -U postgres -c "SELECT 1"
```

**For remote PostgreSQL:**
```bash
# Verify DATABASE_URL
echo $DATABASE_URL

# Test connection directly
psql $DATABASE_URL -c "SELECT 1"
```

**Verify tables exist:**
```bash
# For local postgres
docker compose exec postgres psql -U postgres -d remote_coding_agent -c "\dt"

# Should show: remote_agent_codebases, remote_agent_conversations, remote_agent_sessions
```

### Clone Command Fails

**Verify GitHub token:**
```bash
cat .env | grep GH_TOKEN
# Should have both GH_TOKEN and GITHUB_TOKEN set
```

**Test token validity:**
```bash
# Test GitHub API access
curl -H "Authorization: token $GH_TOKEN" https://api.github.com/user
```

**Check workspace permissions:**
```bash
# Use the service name matching your profile
docker compose exec app ls -la /workspace          # --profile external-db
docker compose exec app-with-db ls -la /workspace  # --profile with-db
```

**Try manual clone:**
```bash
docker compose exec app git clone https://github.com/user/repo /workspace/test-repo
# Or app-with-db if using --profile with-db
```

### GitHub Webhook Not Triggering

**Verify webhook delivery:**
1. Go to your webhook settings in GitHub
2. Click on the webhook
3. Check "Recent Deliveries" tab
4. Look for successful deliveries (green checkmark)

**Check webhook secret:**
```bash
cat .env | grep WEBHOOK_SECRET
# Must match exactly what you entered in GitHub
```

**Verify ngrok is running (local dev):**
```bash
# Check ngrok status
curl http://localhost:4040/api/tunnels
# Or visit http://localhost:4040 in browser
```

**Check application logs for webhook processing:**
```bash
docker compose logs -f app | grep GitHub          # --profile external-db
docker compose logs -f app-with-db | grep GitHub  # --profile with-db
```

### TypeScript Compilation Errors

**Clean and rebuild:**
```bash
# Stop containers (use the profile you started with)
docker compose --profile external-db down  # or --profile with-db

# Clean build
rm -rf dist node_modules
npm install
npm run build

# Restart (use the profile you need)
docker compose --profile external-db up -d --build  # or --profile with-db
```

**Check for type errors:**
```bash
npm run type-check
```

### Container Won't Start

**Check logs for specific errors:**
```bash
docker compose logs app          # If using --profile external-db
docker compose logs app-with-db  # If using --profile with-db
```

**Verify environment variables:**
```bash
# Check if .env is properly formatted (include your profile)
docker compose --profile external-db config  # or --profile with-db
```

**Rebuild without cache:**
```bash
docker compose --profile external-db build --no-cache  # or --profile with-db
docker compose --profile external-db up -d             # or --profile with-db
```

**Check port conflicts:**
```bash
# See if port 3000 is already in use
# Linux/Mac:
lsof -i :3000

# Windows:
netstat -ano | findstr :3000
```

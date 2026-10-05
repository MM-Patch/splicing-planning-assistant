# Splicing Planning Assistant — Hosting Guide

## Best low-cost path: Render + GitHub
This is the simplest way to get around the work-computer Node/API block. The app runs on Render, and your team opens one HTTPS URL in Chrome/Edge.

### What you need
- A GitHub account.
- A Render account: https://render.com
- Monday API token with access to:
  - Project Tracker board: `5077578194`
  - 2026 D2D Zone Planner / RFS board: `18391791372`
- Optional Teams incoming webhook URL for the PMO Splicing channel.

### Steps
1. Create a private GitHub repo, for example: `splicing-planning-assistant`.
2. Upload the contents of the `SplicingPlanningAssistant` folder into that repo.
3. In Render, choose **New +** → **Web Service**.
4. Connect the GitHub repo.
5. Use these settings:
   - Environment: `Node`
   - Build command: `npm install --omit=dev`
   - Start command: `node server.mjs`
   - Plan: Free is fine for testing.
6. Add environment variables in Render:
   - `MONDAY_API_KEY` = your Monday API token
   - `TEAMS_WEBHOOK_URL` = optional Teams channel webhook
7. Deploy.
8. Open the Render URL. Example: `https://splicing-planning-assistant.onrender.com`
9. In the app, open **Settings** → **Test Monday**. If it connects, the hosted backend can reach Monday.

### Why this should work when the desktop app did not
Your work computer blocked local Node from calling `api.monday.com`. Hosted Render runs outside that work-computer firewall, so Monday API calls usually work as long as the Monday token is valid.

### What Codex / another developer would need
Give them:
- This ZIP or the `SplicingPlanningAssistant` folder.
- GitHub repo access.
- Render access, or permission to create the Render service.
- Do **not** paste the Monday token into code. Add it only as a Render environment variable.

### Production cautions
- Free Render services can sleep after inactivity. First load may take 30–60 seconds.
- For production, move to a paid always-on Render service or IT-hosted server.
- Keep Monday as system of record.
- Use webhook idempotency/audit before enabling automatic two-way posting.

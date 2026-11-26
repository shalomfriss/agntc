# Agentic Workbench for VS Code

Agentic Workbench adds provider connections, reusable agents, linked workflows, and run reports to the VS Code Activity Bar.

## Start

Launch Agentic Workbench and open a trusted workspace folder. Select the Agentic Workbench icon in the Activity Bar or **Open Agentic Workbench** on the Welcome screen. Choose **Connect AI Provider**, then use the play button beside **Code Factory**. The command palette also has **Agentic: Run Code Factory**. Type the coding request or select a multiline task in the editor before starting the run.

## Connect providers

| Provider | Connection |
| --- | --- |
| GitHub Copilot | Enable GitHub Copilot Chat, sign in to GitHub, and select an available model. VS Code handles consent. |
| OpenAI Codex | Install the Codex CLI, sign in with `codex login`, and choose the CLI default or specify a model. |
| Claude Code | Install Claude Code, sign in with `claude auth login`, and choose the CLI default or specify a model. |
| OpenAI API | Enter an OpenAI API key and a Responses API model ID. |
| Anthropic API | Enter an Anthropic API key and a Messages API model ID. |
| Google Gemini | Enter a Google AI Studio API key and a Gemini model ID. |
| OpenAI-compatible | Enter a compatible base URL, a model ID, and a key if required. This works with endpoints that implement `/chat/completions`, including local servers. |

The first connection becomes the workbench default. Select a provider in the sidebar to change its model, check the connection, update its key, or change the default. API keys use VS Code SecretStorage. Account connections use the provider's existing VS Code or CLI sign-in. CLI adapters run with the extension host's PATH. On remote workspaces, install and authenticate the CLIs in the remote environment.

Each model receives the request, the upstream outputs or delegated task supplied to it, and the workspace context it reads through its tools. Choose connections according to where that data may be processed.

## Build agents and workflows

- The Agentic Workbench sidebar has the **Workbench** tree plus a **Details** panel below it with **Workflow** and **Output** tabs: clicking a workflow opens the Workflow tab, starting a run opens the Output tab, and you can switch between them anytime. **Agent Details** opens in the secondary (right) sidebar.
- Click an agent in the tree or a workflow's agent node (or **Create Agent**) to edit it in **Agent Details** on the right. Set its name, multiline instructions, provider, model, and workspace access, then save. **Load Models** lists options for providers with a model catalog. You can also follow the provider default or enter a model ID. **Used by** shows parent agents and workflow assignments. Use **Discard** to restore the saved configuration.
- Use **Add a subagent** to link existing agents. A subagent can serve several parents and have subagents of its own. It uses its configured provider, with access bounded by the parent run.
- Set **Max dynamic subagents** to let an agent launch its own ad-hoc worker subagents at runtime, up to that count per run. Each worker runs once with the agent's model and access and returns its result. Leave the field empty to disable dynamic spawning.
- Use **Skills** to attach installed skills to an agent. The list is discovered from `~/.claude/skills`, `~/.codex/skills`, and each workspace `.claude/skills` folder (every `SKILL.md`). The selected skills' guidance is added to the agent's instructions when it runs, so it works with any provider.
- Open the **Workflow Canvas** (click a workflow in the tree, or the type-hierarchy button beside it) for a visual editor. Add **Agent** and **Input** nodes, drag a node's bottom port into another node's top port to feed its output onward, drag nodes to arrange them, **Save** the layout, and press **Run**. Click an agent node to open its parameters in **Agent Details** on the right (the canvas stays on the Workflow tab). An **Input** node supplies the launch input to the agents you connect it to, so workflows without one run their agents from their instructions. Agent nodes show their configured subagents nested inside the block and a badge when dynamic spawning is enabled. **Code Factory** is listed in the canvas by default as a read-only role pipeline you can run.
- **Create Workflow** also lets you add steps and link inputs through quick picks: **Edit step or link inputs** then **Link upstream outputs**. Workflows execute in dependency order and report the output of each terminal step.
- Runs stream live into the **Output** tab. Each past run is saved under **Runs** — click one to reload its full output (request and every stage) into the **Output** tab, or use **Open Full Run Report** for the Markdown report in the editor.
- Agents with write access can create and edit workspace text files or move them to Trash. Review workspace changes with the VS Code Source Control view as usual. Runs and their Markdown reports are available under **Runs**.

## Code Factory

The Planning Agent inspects the workspace and produces an implementation plan. The Coding Agent receives that plan and applies changes. The LLM Judge receives the original request, the plan, and workspace diffs. A revision verdict sends its findings back to the Planning Agent. After approval, the Testing Agent writes a manual test plan covering the change and its purpose, setup, exact steps, expected results, regressions, and cleanup as applicable. The report opens in the editor when the run ends.

You can assign a different agent to each of the four roles in **Manage Code Factory** or change the maximum number of revisions. The default allows two revisions after the initial review.

| Planning mode | Requirements and artifacts |
| --- | --- |
| **Unstructure** | The Planning Agent creates its own plan from the request and workspace. |
| **OpenSpec** | Requires OpenSpec CLI 2.1+ on PATH. Code Factory creates a local change, uses OpenSpec's artifact instructions, validates the change, then passes the apply instructions to the Coding Agent. |
| **SpecKit** | Requires Spec Kit's `specify` CLI and Python 3 on PATH. Code Factory uses the official generic integration and Spec Kit setup scripts to produce a constitution where needed, a feature spec, a plan, and tasks, then passes the implementation instructions to the Coding Agent. |

Structured planning writes its artifacts into the selected workspace. OpenSpec mode supports workspace-local planning roots. Spec Kit mode uses the generic spec-driven flow and leaves Git branch management to the user. A cancelled or failed run saves a report so you can inspect any edits made before it ended.

Provider and framework references are available in the [VS Code Language Model API](https://code.visualstudio.com/api/extension-guides/ai/language-model), [OpenSpec CLI reference](https://github.com/Fission-AI/OpenSpec/blob/main/docs/cli.md), and [Spec Kit generic integration guide](https://github.github.com/spec-kit/integrations/generic.html).

## Development

```sh
npm ci
npm test
AGENTIC_FRAMEWORK_TESTS=1 npm test
```

Run these commands from the Agentic Workbench component directory. The opt-in tests use the installed OpenSpec and Spec Kit CLIs.

# AI Office

The unified environment housing AI agents, skills, workflows, and automation for software engineering activities across target projects.

## Language

**AI Office**:
A unified environment housing AI agents, skills, workflows, and automation for software engineering activities across target projects.
_Avoid_: Software factory, workspace, bot team, virtual department

**Office Manager**:
Riley, the primary conversational front-door agent responsible for receiving human inquiries and providing advisory workflow routing through ask-matt.
_Avoid_: Dispatcher, scheduler, supervisor, bot

**Specialist Agent**:
An AI agent within the AI Office responsible for performing specific tasks using assigned skills.
_Avoid_: Worker bot, subagent runner

**Skill**:
A reusable set of instructions and procedures that guides an agent in performing a specific task.
_Avoid_: Tool, action script

**Workflow**:
An ordered sequence of tasks and skills used to achieve an engineering outcome.
_Avoid_: Pipeline, process flow

**Target Project**:
A codebase repository on the same server, external to the AI Office, where engineering work is performed.
_Avoid_: Downstream repo, client repo, code folder

**Active Project**:
The single currently designated Target Project referenced by all AI Office agents, managed exclusively by the user via Project Settings.
_Avoid_: Current repo, working directory, selected workspace

**Project Settings**:
The persistent registry of known Target Projects and the active project selection, configured by the user through the Web UI and read-only to agents.
_Avoid_: Repo list, workspace config, project DB

**Web UI**:
A containerized browser interface providing visual chat with AI Office agents, active project management, and copy-paste action delivery.
_Avoid_: Dashboard, admin portal, management console

**Host Bridge**:
A lightweight host-side service exposing secure, authenticated APIs that connect the containerized Web UI with host processes (tmux, Claude Code, project settings).
_Avoid_: Backend server, proxy daemon, agent controller

**Session Transcript**:
The structured JSONL record maintained by Claude Code for the active agent session, consumed by the Host Bridge to render clean chat streams.
_Avoid_: Terminal log, chat history, console dump

**Input Lease**:
A soft lock mechanism coordinating user input between the Web UI and native terminal to prevent simultaneous conflicting keystrokes.
_Avoid_: Terminal mutex, input lock, focus grabber

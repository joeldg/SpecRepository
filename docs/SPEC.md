# Product Specification: SpecRegistry (Markdown Specification Management System)

## 1. Objective & Overview

SpecRegistry is a centralized management interface, API, and CLI tool designed to govern, version, and distribute Markdown-based project specification files (e.g., `DESIGN.md`, `STRUCTURE.md`, `API.md`). Think of it as "Avro for human and AI-readable text."

The system ensures that both human developers and AI agents operate against unified, version-controlled guidelines. It features an interactive Web UI for management, a robust API featuring a specialized feedback loop for AI agents, and a developer-facing CLI for scaffolding and spec generation.

---

## 2. Core Architecture & System Components

```
┌────────────────────────────────────────────────────────┐
│                        Web UI                          │
│   (Management, Version Control, Review, Analytics)     │
└───────────┬────────────────────────────────────────────┘
            │
            ▼
┌────────────────────────────────────────────────────────┐
│                      Backend API                       │
│  (Spec Engine, AI Feedback Ingestion, Prompt Stubs)    │
└───────────▲────────────────────────────────▲───────────┘
            │                                │
            ▼                                ▼
┌──────────────────────┐        ┌──────────────────────┐
│    Developer CLI     │        │      AI Agents       │
│  (Init / Generate)   │        │ (Read Specs/Feedback)│
└──────────────────────┘        └──────────────────────┘
```

### 2.1. Web Management Interface

* **Organization Hierarchy:**
    * **Global Level:** Specs that apply across the entire organization (e.g., Global Security, General Coding Standards).
    * **Project Type Level:** Domain-specific groupings (e.g., Thinkom Hardware Specs, Thinkom Firmware Specs, Web App Standard). Fully configurable via UI to support any industry pivot.
* **Specification Lifecycle Management:**
    * Markdown editor with side-by-side preview.
    * Author attribution, date tracking, and strict Semantic Versioning (`MAJOR.MINOR.PATCH`).
* **Change Management & Review Workflow:**
    * Proposed changes to a spec enter a "Pending Review" status.
    * Diff viewer showing line-by-line changes.
    * Approval/Rejection tracking before a new version is published.

### 2.2. Developer CLI (`specreg`)

A command-line interface deployed to developer environments to synchronize local codebases with the central registry.

* **Scenario A: New Directory Scaffolding (`specreg init`)**
    1. Interactive prompt walks the user through selecting the Industry/Organization and Project Type.
    2. Pulls the latest approved markdown specs for that type from the server.
    3. Populates a local `.spec/` or `specs/` directory with the files.
* **Scenario B: Existing Directory Discovery (`specreg generate`)**
    1. Scans the existing directory structure and files.
    2. Sends structural metadata to the server.
    3. Fetches specialized stubbed LLM prompts from the server to parse the local codebase and automatically generate the matching `DESIGN.md` or `STRUCTURE.md` files.

### 2.3. AI Agent Integration & Feedback Loop

* **Ingestion Endpoint:** Dedicated API layout allowing autonomous AI agents to query the latest specifications.
* **Telemetry & Error Reporting:** If an AI agent encounters a contradiction, ambiguity, or bug within a specification during execution, it hits a specialized feedback endpoint to flag the issue for human review.

---

## 3. Data Models & Schema

### 3.1. Project Type

```json
{
  "id": "uuid",
  "name": "Thinkom Edge Device",
  "scope": "project_type",
  "industry": "Aerospace/Telecommunications",
  "created_at": "timestamp",
  "updated_at": "timestamp"
}
```

### 3.2. Specification File

```json
{
  "id": "uuid",
  "project_type_id": "uuid",
  "filename": "STRUCTURE.md",
  "current_version": "2.1.0",
  "status": "published",
  "content": "string (markdown content)",
  "updated_by": "author_id",
  "updated_at": "timestamp"
}
```

### 3.3. Change Log / Review

```json
{
  "id": "uuid",
  "spec_id": "uuid",
  "proposed_by": "user_id",
  "version_delta": "minor",
  "diff": "string",
  "reviewers": ["user_id"],
  "status": "approved"
}
```

### 3.4. AI Agent Feedback

```json
{
  "id": "uuid",
  "spec_id": "uuid",
  "spec_version": "2.1.0",
  "agent_identifier": "Codegen-GPT4o-v1",
  "error_type": "ambiguity",
  "context_code_snippet": "string",
  "description": "The specification states variable X must be an integer, but code architecture requires a float for precision.",
  "timestamp": "timestamp"
}
```

## 4. API Endpoints

### 4.1. Specifications & Management

* `GET /api/v1/specs` - Retrieve all global and project-type specs.
* `GET /api/v1/specs/:project_type/download` - Fetch zipped spec folder for CLI initialization.
* `POST /api/v1/specs/review` - Submit a markdown change request.

### 4.2. AI Feedback & Telemetry

* `POST /api/v1/ai/feedback`
   * Payload: AI Agent Feedback schema.
   * Behavior: Flags the target specification version in the Web UI dashboard, creating an alert for the spec authors.

### 4.3. CLI Codebase Parsing Stubs

* `POST /api/v1/cli/stub-prompts`
   * Payload: `{ "project_type": "string", "detected_languages": ["string"] }`
   * Response: Returns tailored LLM prompts for generating missing specification files based on existing code context.

## 5. Embedded Prompt Stubs (Server-Side)

The server must host and serve the following prompt templates when a CLI requests generation tools for existing projects:

### 5.1. Stub: `DESIGN.md` Generation Prompt

```
You are an expert software architect. Analyze the provided file structure and codebase context:
[CONTEXT]

Generate a comprehensive DESIGN.md file conforming to the standard template. The output must detail:
1. System Architecture and component interactions.
2. High-level design patterns implemented.
3. Data flow patterns.

Output strict markdown. Do not include chat conversational text.
```

### 5.2. Stub: `STRUCTURE.md` Generation Prompt

```
You are an AI system specialized in codebase mapping. Analyze the following directory tree and file signatures:
[TREE]

Generate a STRUCTURE.md file that maps out:
1. Core directory purposes.
2. Entry points and configuration files.
3. Dependency mapping between modules.

Output strict markdown. Avoid fluff.
```

## 6. Non-Functional Requirements

* **UI Aesthetic:** High-density, clean, technical dashboard (similar to modern developer tools like Vercel or Linear) optimizing for scannability and quick diff comparison.
* **Extensibility:** No hardcoded industry structures. The "Thinkom" project patterns must simply be a seeded configuration of the underlying generic hierarchical model.

# Google Style Guide Integration

SpecRegistry can add Google's public style guides to a repository during `specreg init`.
The guides are fetched from `https://google.github.io/styleguide/`, converted to Markdown
when the upstream source is HTML or XML, and written as project-local advisory context.

This integration is intentionally project-local. Registry specs remain the governed,
versioned source of truth. Google style guides help agents and developers make better
language and documentation choices, but they do not replace project-specific specs and are
not checked by `specreg check`.

## What Init Writes

By default, `specreg init` writes selected guides to:

```text
.spec/styleguides/
  google-documentation-guide.md
  google-typescript-style-guide.md
  google-styleguides.json
```

The exact files depend on the repository scan and user selection.

`google-styleguides.json` records:

- the provider (`google-styleguide`)
- the fetch timestamp
- detected repository languages
- selected guide IDs, titles, local paths, and source URLs

When guide files are installed, `SPECREGISTRY.md` also includes an "External Style Guides"
section so AI agents can discover the files from the repository root.

## Selection Modes

Interactive init shows a multi-select list. Suggested guides are marked with `*`.
Press Enter to accept suggestions, enter comma-separated numbers or IDs to customize, or
enter `all` or `none`.

Automation can use flags:

```sh
specreg init --styleguides suggested
specreg init --styleguides typescript,html-css,docguide
specreg init --styleguides none
specreg init --styleguides all --styleguide-dir docs/google-styleguides --force
```

`--styleguides suggested` is the best default for CI-like bootstrap scripts because it
avoids prompts while still using repository evidence.

`--styleguides none` disables guide installation.

`--force` refreshes existing guide files. Without `--force`, existing guide files are left
in place to avoid overwriting local notes or curated copies.

## Suggested Guide Detection

The CLI scans the repository and maps file extensions to detected languages. The
documentation guide is always suggested because most governed projects have Markdown docs
or agent-facing repository guidance.

Current suggestions include:

| Detected language | Suggested guide ID |
| --- | --- |
| `Markdown` | `docguide` |
| `TypeScript` | `typescript` |
| `JavaScript` | `javascript` |
| `HTML`, `CSS` | `html-css` |
| `JSON` | `json` |
| `Python` | `python` |
| `Go` | `go` |
| `Java` | `java` |
| `C`, `C++` | `cpp` |
| `C#` | `csharp` |
| `Shell` | `shell` |
| `Swift` | `swift` |

## Available Guide IDs

| ID | Output file | Source |
| --- | --- | --- |
| `docguide` | `google-documentation-guide.md` | `/docguide/`, `/docguide/style.html`, `/docguide/best_practices.html`, `/docguide/READMEs.html`, `/docguide/philosophy.html` |
| `typescript` | `google-typescript-style-guide.md` | `/tsguide.html` |
| `javascript` | `google-javascript-style-guide.md` | `/jsguide.html` |
| `html-css` | `google-html-css-style-guide.md` | `/htmlcssguide.html` |
| `json` | `google-json-style-guide.md` | `/jsoncstyleguide.xml` |
| `python` | `google-python-style-guide.md` | `/pyguide.html` |
| `go` | `google-go-style-guide.md` | `/go/` |
| `java` | `google-java-style-guide.md` | `/javaguide.html` |
| `cpp` | `google-cpp-style-guide.md` | `/cppguide.html` |
| `csharp` | `google-csharp-style-guide.md` | `/csharp-style.html` |
| `shell` | `google-shell-style-guide.md` | `/shellguide.html` |
| `swift` | `google-swift-style-guide.md` | `/swiftguide.html` |

## SDD Semantics

Google style guides are external process inputs:

- They are fetched per repository so each project can choose the relevant language set.
- They are stored outside `specs/` so governed spec sync remains deterministic.
- They are listed in `SPECREGISTRY.md` so agents can load them when useful.
- They should be treated as advisory unless a governed SpecRegistry spec explicitly adopts
  a rule from them.

If a Google guide conflicts with a governed spec, the governed spec wins. Agents should
report the conflict with `report_spec_feedback` instead of guessing which rule to follow.

If a team wants a Google rule to become mandatory, copy or summarize the requirement into a
reviewed SpecRegistry spec and publish it through the normal registry workflow.

## Refreshing Guides

To refresh the latest upstream copies:

```sh
specreg init --styleguides suggested --force
```

This also re-fetches the governed spec bundle. `specreg sync` does not refresh style guides;
it only updates registry-governed specs.


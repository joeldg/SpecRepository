import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const IGNORED_DIRS = new Set([
  ".git",
  ".spec",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "venv",
]);

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".sql"]);
const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all"]);
const CONFIG_FILENAMES = new Set(["package.json", "tsconfig.json", "vite.config.ts", "vite.config.js"]);

export type CodeEntityKind =
  | "file"
  | "import"
  | "class"
  | "interface"
  | "type"
  | "function"
  | "method"
  | "route"
  | "command"
  | "config"
  | "migration"
  | "schema"
  | "field"
  | "index";

type MetadataValue = string | number | boolean | string[];

export interface CodeEntity {
  id: string;
  kind: CodeEntityKind;
  language: string;
  path: string;
  name: string;
  signature: string;
  start_line: number;
  start_column: number;
  end_line: number;
  hash: string;
  parent_id?: string;
  metadata?: Record<string, MetadataValue>;
}

export interface CodeInventory {
  schema_version: 1;
  generated_at: string;
  root: string;
  entity_count: number;
  languages: string[];
  entities: CodeEntity[];
  coverage?: CodeCoverageSummary;
  drift?: CodeDriftSummary;
}

export interface CodeMapOptions {
  root: string;
  out: string;
  force: boolean;
  specsDir?: string;
  traceOut?: string;
}

export interface SpecReference {
  filename: string;
  title: string;
  version?: string;
  sections: string[];
  content: string;
}

export interface TraceabilityLink {
  entity_id: string;
  entity_name: string;
  entity_kind: CodeEntityKind;
  spec_filename: string;
  confidence: number;
  reasons: string[];
}

export interface CodeCoverageSummary {
  governed_entity_count: number;
  linked_entity_count: number;
  unlinked_entity_count: number;
  coverage_ratio: number;
  linked_by_kind: Record<string, number>;
  unlinked_by_kind: Record<string, number>;
}

export interface CodeDriftSummary {
  score: number;
  severity: "none" | "low" | "medium" | "high";
  signals: string[];
}

export interface CodeAlias {
  previous_id: string;
  current_id: string;
  reason: "same_hash" | "same_path_name";
}

export interface CodeTraceReport {
  schema_version: 1;
  generated_at: string;
  root: string;
  specs_dir: string;
  spec_count: number;
  entity_count: number;
  links: TraceabilityLink[];
  unlinked_entities: Array<Pick<CodeEntity, "id" | "kind" | "path" | "name" | "signature" | "start_line">>;
  aliases: CodeAlias[];
  coverage: CodeCoverageSummary;
  drift: CodeDriftSummary;
  embedding_profile: {
    default_scope: string[];
    recommended_fields: string[];
    notes: string;
  };
}

interface AddEntityInput {
  kind: CodeEntityKind;
  language: string;
  relativePath: string;
  name: string;
  signature: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  body: string;
  parentId?: string;
  metadata?: Record<string, MetadataValue>;
}

function digest(value: string, length = 16): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, length);
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function languageFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".ts" || ext === ".tsx") return "TypeScript";
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") return "JavaScript";
  if (ext === ".py") return "Python";
  if (ext === ".sql") return "SQL";
  if (ext === ".json") return "JSON";
  return "Unknown";
}

function lineColumnFromOffset(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lines = before.split(/\r?\n/);
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

function nodeLineColumn(source: ts.SourceFile, node: ts.Node): { line: number; column: number } {
  const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
  return { line: pos.line + 1, column: pos.character + 1 };
}

function nodeEndLine(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
}

function cleanSignature(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function signatureFromNode(source: ts.SourceFile, node: ts.Node): string {
  return cleanSignature(node.getText(source).split(/\r?\n/)[0] ?? "");
}

function makeId(input: Omit<AddEntityInput, "body" | "metadata">): string {
  const stable = [
    input.language,
    input.kind,
    input.relativePath,
    input.parentId ?? "",
    input.name,
    input.signature,
  ].join("|");
  return `code:${input.kind}:${digest(stable)}`;
}

function addEntity(entities: CodeEntity[], input: AddEntityInput): CodeEntity {
  const id = makeId(input);
  const entity: CodeEntity = {
    id,
    kind: input.kind,
    language: input.language,
    path: input.relativePath,
    name: input.name,
    signature: input.signature,
    start_line: input.startLine,
    start_column: input.startColumn,
    end_line: input.endLine,
    hash: digest(input.body, 24),
    ...(input.parentId ? { parent_id: input.parentId } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
  entities.push(entity);
  return entity;
}

function sourceSnippetByLine(content: string, startLine: number, endLine: number): string {
  return content.split(/\r?\n/).slice(Math.max(0, startLine - 1), Math.max(startLine, endLine)).join("\n");
}

function collectFiles(root: string): string[] {
  const files: string[] = [];
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".env") continue;
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) || CONFIG_FILENAMES.has(entry.name)) {
        files.push(full);
      }
    }
  }
  walk(root);
  return files;
}

function addFileEntity(entities: CodeEntity[], root: string, file: string, content: string): CodeEntity {
  const relativePath = normalizePath(path.relative(root, file));
  const language = languageFor(file);
  const lines = content.split(/\r?\n/).length;
  return addEntity(entities, {
    kind: "file",
    language,
    relativePath,
    name: relativePath,
    signature: relativePath,
    startLine: 1,
    startColumn: 1,
    endLine: lines,
    body: content,
  });
}

function extractTypeScript(root: string, file: string, content: string, entities: CodeEntity[], fileEntity: CodeEntity): void {
  const relativePath = normalizePath(path.relative(root, file));
  const language = languageFor(file);
  const sourceKind = file.endsWith(".tsx") || file.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, sourceKind);
  const classStack: string[] = [];

  function addNode(kind: CodeEntityKind, name: string, node: ts.Node, parentId?: string, metadata?: Record<string, MetadataValue>): CodeEntity {
    const loc = nodeLineColumn(source, node);
    return addEntity(entities, {
      kind,
      language,
      relativePath,
      name,
      signature: signatureFromNode(source, node),
      startLine: loc.line,
      startColumn: loc.column,
      endLine: nodeEndLine(source, node),
      body: node.getText(source),
      parentId: parentId ?? fileEntity.id,
      metadata,
    });
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      const moduleSpecifier = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : node.moduleSpecifier.getText(source);
      const loc = nodeLineColumn(source, node);
      addEntity(entities, {
        kind: "import",
        language,
        relativePath,
        name: moduleSpecifier,
        signature: signatureFromNode(source, node),
        startLine: loc.line,
        startColumn: loc.column,
        endLine: nodeEndLine(source, node),
        body: node.getText(source),
        parentId: fileEntity.id,
        metadata: { module: moduleSpecifier },
      });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const loc = nodeLineColumn(source, node);
      addEntity(entities, {
        kind: "import",
        language,
        relativePath,
        name: node.moduleSpecifier.text,
        signature: signatureFromNode(source, node),
        startLine: loc.line,
        startColumn: loc.column,
        endLine: nodeEndLine(source, node),
        body: node.getText(source),
        parentId: fileEntity.id,
        metadata: { module: node.moduleSpecifier.text, export: true },
      });
    } else if (ts.isClassDeclaration(node) && node.name) {
      const entity = addNode("class", node.name.text, node);
      classStack.push(entity.id);
      ts.forEachChild(node, visit);
      classStack.pop();
      return;
    }
    if (ts.isInterfaceDeclaration(node)) {
      addNode("interface", node.name.text, node);
    } else if (ts.isTypeAliasDeclaration(node)) {
      addNode("type", node.name.text, node);
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      addNode("function", node.name.text, node);
    } else if (ts.isMethodDeclaration(node) && node.name) {
      addNode("method", node.name.getText(source), node, classStack[classStack.length - 1] ?? fileEntity.id);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
        addNode("function", node.name.text, node);
      }
    } else if (ts.isCallExpression(node)) {
      const route = routeFromCall(source, node);
      if (route) {
        const loc = nodeLineColumn(source, node);
        const method = route.method.toUpperCase();
        addEntity(entities, {
          kind: "route",
          language,
          relativePath,
          name: `${method} ${route.path}`,
          signature: `${method} ${route.path}`,
          startLine: loc.line,
          startColumn: loc.column,
          endLine: nodeEndLine(source, node),
          body: node.getText(source),
          parentId: fileEntity.id,
          metadata: {
            method,
            route_path: route.path,
          },
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
}

function routeFromCall(source: ts.SourceFile, node: ts.CallExpression): { method: string; path: string } | undefined {
  if (!ts.isPropertyAccessExpression(node.expression)) return undefined;
  const method = node.expression.name.text.toLowerCase();
  if (!ROUTE_METHODS.has(method)) return undefined;
  const receiver = node.expression.expression.getText(source).toLowerCase();
  if (!/(^|\.)(app|api|router|routes|server|fastify)$/.test(receiver)) return undefined;
  const first = node.arguments[0];
  if (!first || (!ts.isStringLiteral(first) && !ts.isNoSubstitutionTemplateLiteral(first))) return undefined;
  return { method, path: first.text };
}

function extractPython(root: string, file: string, content: string, entities: CodeEntity[], fileEntity: CodeEntity): void {
  const relativePath = normalizePath(path.relative(root, file));
  const lines = content.split(/\r?\n/);
  let pendingRoute: { method: string; routePath: string; line: number } | undefined;
  const classStack: Array<{ indent: number; id: string }> = [];

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    while (classStack.length > 0 && indent <= classStack[classStack.length - 1].indent && line.trim()) classStack.pop();

    const importMatch = line.match(/^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import\s+(.+)|import\s+(.+))/);
    if (importMatch) {
      const moduleName = importMatch[1] ?? (importMatch[3] ?? "").split(",")[0].trim();
      addEntity(entities, {
        kind: "import",
        language: "Python",
        relativePath,
        name: moduleName,
        signature: cleanSignature(line),
        startLine: lineNumber,
        startColumn: indent + 1,
        endLine: lineNumber,
        body: line,
        parentId: fileEntity.id,
        metadata: { module: moduleName },
      });
      return;
    }

    const routeMatch = line.match(/^\s*@[\w.]+\.(get|post|put|patch|delete|options|head|route)\(["']([^"']+)["']/i);
    if (routeMatch) {
      pendingRoute = { method: routeMatch[1].toUpperCase() === "ROUTE" ? "ANY" : routeMatch[1].toUpperCase(), routePath: routeMatch[2], line: lineNumber };
      return;
    }

    const classMatch = line.match(/^\s*class\s+([A-Za-z_][\w]*)\b/);
    if (classMatch) {
      const entity = addEntity(entities, {
        kind: "class",
        language: "Python",
        relativePath,
        name: classMatch[1],
        signature: cleanSignature(line),
        startLine: lineNumber,
        startColumn: indent + 1,
        endLine: lineNumber,
        body: line,
        parentId: fileEntity.id,
      });
      classStack.push({ indent, id: entity.id });
      return;
    }

    const functionMatch = line.match(/^\s*(async\s+def|def)\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)/);
    if (functionMatch) {
      const parentId = classStack[classStack.length - 1]?.id ?? fileEntity.id;
      const fn = addEntity(entities, {
        kind: parentId === fileEntity.id ? "function" : "method",
        language: "Python",
        relativePath,
        name: functionMatch[2],
        signature: cleanSignature(line),
        startLine: lineNumber,
        startColumn: indent + 1,
        endLine: lineNumber,
        body: line,
        parentId,
        metadata: { async: functionMatch[1].startsWith("async") },
      });
      if (pendingRoute) {
        addEntity(entities, {
          kind: "route",
          language: "Python",
          relativePath,
          name: `${pendingRoute.method} ${pendingRoute.routePath}`,
          signature: `${pendingRoute.method} ${pendingRoute.routePath} -> ${functionMatch[2]}`,
          startLine: pendingRoute.line,
          startColumn: 1,
          endLine: lineNumber,
          body: `${lines[pendingRoute.line - 1]}\n${line}`,
          parentId: fn.id,
          metadata: { method: pendingRoute.method, route_path: pendingRoute.routePath, handler: functionMatch[2] },
        });
        pendingRoute = undefined;
      }
    }
  });
}

function extractSql(root: string, file: string, content: string, entities: CodeEntity[], fileEntity: CodeEntity): void {
  const relativePath = normalizePath(path.relative(root, file));
  if (/\/?migrations?\//i.test(relativePath) || /^\d+[_-].+\.sql$/i.test(path.basename(relativePath))) {
    addEntity(entities, {
      kind: "migration",
      language: "SQL",
      relativePath,
      name: path.basename(relativePath),
      signature: relativePath,
      startLine: 1,
      startColumn: 1,
      endLine: content.split(/\r?\n/).length,
      body: content,
      parentId: fileEntity.id,
      metadata: { migration_file: true },
    });
  }
  for (const match of content.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?([A-Za-z_][\w.]*)/gi)) {
    const loc = lineColumnFromOffset(content, match.index ?? 0);
    const table = addEntity(entities, {
      kind: "schema",
      language: "SQL",
      relativePath,
      name: match[1],
      signature: cleanSignature(match[0]),
      startLine: loc.line,
      startColumn: loc.column,
      endLine: loc.line,
      body: sourceSnippetByLine(content, loc.line, loc.line),
      parentId: fileEntity.id,
      metadata: { object_type: "table" },
    });
    const tableStart = match.index ?? 0;
    const after = content.slice(tableStart);
    const statement = after.slice(0, Math.max(after.indexOf(";"), after.indexOf("\n\n"), 0) || after.length);
    const open = statement.indexOf("(");
    const close = statement.lastIndexOf(")");
    if (open >= 0 && close > open) {
      const fields = statement
        .slice(open + 1, close)
        .split(",")
        .map((field) => field.trim())
        .filter((field) => /^[A-Za-z_"][\w"]*\s+/.test(field) && !/^(constraint|primary|foreign|unique|check)\b/i.test(field));
      for (const field of fields) {
        const name = field.match(/^["`[]?([A-Za-z_][\w]*)/)?.[1];
        if (!name) continue;
        const fieldLoc = lineColumnFromOffset(content, tableStart + Math.max(0, statement.indexOf(field)));
        addEntity(entities, {
          kind: "field",
          language: "SQL",
          relativePath,
          name: `${match[1]}.${name}`,
          signature: cleanSignature(field),
          startLine: fieldLoc.line,
          startColumn: fieldLoc.column,
          endLine: fieldLoc.line,
          body: field,
          parentId: table.id,
          metadata: { table: match[1], field: name },
        });
      }
    }
  }
  for (const match of content.matchAll(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?([A-Za-z_][\w.]*)/gi)) {
    const loc = lineColumnFromOffset(content, match.index ?? 0);
    addEntity(entities, {
      kind: "index",
      language: "SQL",
      relativePath,
      name: match[1],
      signature: cleanSignature(match[0]),
      startLine: loc.line,
      startColumn: loc.column,
      endLine: loc.line,
      body: sourceSnippetByLine(content, loc.line, loc.line),
      parentId: fileEntity.id,
    });
  }
}

function extractConfig(root: string, file: string, content: string, entities: CodeEntity[], fileEntity: CodeEntity): void {
  const relativePath = normalizePath(path.relative(root, file));
  const filename = path.basename(file);
  if (filename === "package.json") {
    try {
      const pkg = JSON.parse(content) as {
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
        addEntity(entities, {
          kind: "command",
          language: "JSON",
          relativePath,
          name,
          signature: `${name}: ${command}`,
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          body: command,
          parentId: fileEntity.id,
          metadata: { source: "package.json", command },
        });
      }
      const deps = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})].sort();
      addEntity(entities, {
        kind: "config",
        language: "JSON",
        relativePath,
        name: "package dependencies",
        signature: `${deps.length} npm dependencies`,
        startLine: 1,
        startColumn: 1,
        endLine: content.split(/\r?\n/).length,
        body: deps.join("\n"),
        parentId: fileEntity.id,
        metadata: { source: "package.json", dependency_count: deps.length, dependencies: deps.slice(0, 50) },
      });
    } catch {
      return;
    }
  } else {
    addEntity(entities, {
      kind: "config",
      language: languageFor(file),
      relativePath,
      name: filename,
      signature: relativePath,
      startLine: 1,
      startColumn: 1,
      endLine: content.split(/\r?\n/).length,
      body: content,
      parentId: fileEntity.id,
      metadata: { source: filename },
    });
  }
}

const SPEC_ANNOTATION = /@spec\[([^\]#]+)(?:#([a-zA-Z0-9._-]+))?\]/;

/** Mirrors packages/server/src/lib/sections.ts sectionAnchor; kept local so the CLI
 * doesn't need a runtime dependency on the server package for one slugify function. */
function sectionAnchor(section: string): string {
  const base = section
    .trim()
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "intro";
}

/**
 * Scan a file's raw text for `// @spec[FILE#section]` (or block-comment equivalents)
 * and attach the reference to the nearest governable entity declared on the next
 * couple of lines, so an explicit annotation short-circuits the fuzzy text-matching
 * linker below with a high-confidence, human-authored link.
 */
function annotateSpecReferences(content: string, entities: CodeEntity[], relativePath: string): void {
  const fileEntities = entities
    .filter((entity) => entity.path === relativePath && governable(entity))
    .sort((a, b) => a.start_line - b.start_line);
  if (fileEntities.length === 0) return;
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = SPEC_ANNOTATION.exec(lines[i]);
    if (!match) continue;
    const annotationLine = i + 1;
    const filename = match[1].trim();
    const section = match[2]?.trim();
    const target = fileEntities.find((entity) => entity.start_line >= annotationLine && entity.start_line <= annotationLine + 3);
    if (!target) continue;
    target.metadata = {
      ...(target.metadata ?? {}),
      spec_ref: section ? `${filename}#${section}` : filename,
    };
  }
}

function loadSpecs(root: string, specsDir: string): SpecReference[] {
  const dir = path.resolve(root, specsDir);
  if (!fs.existsSync(dir)) return [];
  const specs: SpecReference[] = [];
  function walk(current: string): void {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".md") continue;
      const content = fs.readFileSync(full, "utf8");
      const relative = normalizePath(path.relative(dir, full));
      const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? path.basename(relative, ".md");
      const version = content.match(/\bversion:\s*([^\s]+)/i)?.[1] ?? content.match(/\bcurrent_version:\s*([^\s]+)/i)?.[1];
      const sections = [...content.matchAll(/^##+\s+(.+)$/gm)].map((match) => match[1].trim());
      specs.push({ filename: relative, title, version, sections, content });
    }
  }
  walk(dir);
  return specs;
}

function tokensFor(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^a-z0-9:/._-]+/).filter((token) => token.length >= 3))];
}

function governable(entity: CodeEntity): boolean {
  return !["file", "import", "field"].includes(entity.kind);
}

function linkEntitiesToSpecs(entities: CodeEntity[], specs: SpecReference[]): TraceabilityLink[] {
  const links: TraceabilityLink[] = [];
  const specByFilename = new Map(specs.map((spec) => [spec.filename.toLowerCase(), spec]));
  for (const entity of entities.filter(governable)) {
    const specRef = typeof entity.metadata?.spec_ref === "string" ? entity.metadata.spec_ref : undefined;
    if (specRef) {
      const [refFilename, refSection] = specRef.split("#");
      const spec = specByFilename.get(refFilename.trim().toLowerCase());
      if (spec) {
        // An explicit annotation is a human assertion, not a heuristic guess: link at
        // high confidence and skip the fuzzy matching below entirely for this entity.
        const sectionKnown = !refSection || spec.sections.some((s) => sectionAnchor(s) === refSection.toLowerCase());
        links.push({
          entity_id: entity.id,
          entity_name: entity.name,
          entity_kind: entity.kind,
          spec_filename: spec.filename,
          confidence: sectionKnown ? 1 : 0.9,
          reasons: [
            "explicit @spec annotation",
            ...(refSection ? [sectionKnown ? `section: ${refSection}` : `section "${refSection}" not found in spec`] : []),
          ],
        });
        continue;
      }
    }
    const haystacks = specs.map((spec) => ({ spec, text: `${spec.filename}\n${spec.title}\n${spec.sections.join("\n")}\n${spec.content}`.toLowerCase() }));
    const probes = [
      entity.name,
      entity.signature,
      entity.path,
      String(entity.metadata?.route_path ?? ""),
      String(entity.metadata?.table ?? ""),
      String(entity.metadata?.source ?? ""),
    ].flatMap(tokensFor);
    for (const { spec, text } of haystacks) {
      const matched = probes.filter((probe) => text.includes(probe));
      const directName = entity.name.length >= 3 && text.includes(entity.name.toLowerCase());
      const directRoute = typeof entity.metadata?.route_path === "string" && text.includes(entity.metadata.route_path.toLowerCase());
      if (!directName && !directRoute && matched.length < 2) continue;
      const confidence = Math.min(0.95, 0.35 + matched.length * 0.12 + (directName ? 0.2 : 0) + (directRoute ? 0.25 : 0));
      links.push({
        entity_id: entity.id,
        entity_name: entity.name,
        entity_kind: entity.kind,
        spec_filename: spec.filename,
        confidence: Number(confidence.toFixed(2)),
        reasons: [
          ...(directName ? ["entity name appears in spec"] : []),
          ...(directRoute ? ["route path appears in spec"] : []),
          ...(matched.length ? [`matched tokens: ${matched.slice(0, 6).join(", ")}`] : []),
        ],
      });
    }
  }
  return links.sort((a, b) => a.entity_id.localeCompare(b.entity_id) || b.confidence - a.confidence);
}

function summarizeCoverage(entities: CodeEntity[], links: TraceabilityLink[]): CodeCoverageSummary {
  const governed = entities.filter(governable);
  const linkedIds = new Set(links.map((link) => link.entity_id));
  const byKind = (items: CodeEntity[]) =>
    items.reduce<Record<string, number>>((acc, entity) => {
      acc[entity.kind] = (acc[entity.kind] ?? 0) + 1;
      return acc;
    }, {});
  const linked = governed.filter((entity) => linkedIds.has(entity.id));
  const unlinked = governed.filter((entity) => !linkedIds.has(entity.id));
  return {
    governed_entity_count: governed.length,
    linked_entity_count: linked.length,
    unlinked_entity_count: unlinked.length,
    coverage_ratio: governed.length ? Number((linked.length / governed.length).toFixed(4)) : 1,
    linked_by_kind: byKind(linked),
    unlinked_by_kind: byKind(unlinked),
  };
}

function summarizeDrift(coverage: CodeCoverageSummary, specs: SpecReference[]): CodeDriftSummary {
  const score = Number((coverage.governed_entity_count ? coverage.unlinked_entity_count / coverage.governed_entity_count : 0).toFixed(4));
  const severity = score === 0 ? "none" : score < 0.25 ? "low" : score < 0.5 ? "medium" : "high";
  const signals = [
    `${coverage.unlinked_entity_count} of ${coverage.governed_entity_count} governable code entities have no local spec link`,
    `${specs.length} local spec document${specs.length === 1 ? "" : "s"} scanned`,
  ];
  if (coverage.unlinked_by_kind.route) signals.push(`${coverage.unlinked_by_kind.route} route entity/entities are unmapped`);
  if (coverage.unlinked_by_kind.schema) signals.push(`${coverage.unlinked_by_kind.schema} schema entity/entities are unmapped`);
  return { score, severity, signals };
}

function loadPreviousInventory(root: string, out: string): CodeInventory | undefined {
  const target = path.resolve(root, out);
  if (!fs.existsSync(target)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(target, "utf8")) as CodeInventory;
  } catch {
    return undefined;
  }
}

function aliasChanges(previous: CodeInventory | undefined, current: CodeInventory): CodeAlias[] {
  if (!previous) return [];
  const aliases: CodeAlias[] = [];
  const currentByHash = new Map(current.entities.map((entity) => [entity.hash, entity]));
  const currentByPathName = new Map(current.entities.map((entity) => [`${entity.kind}|${entity.path}|${entity.name}`, entity]));
  for (const oldEntity of previous.entities) {
    if (current.entities.some((entity) => entity.id === oldEntity.id)) continue;
    const sameHash = currentByHash.get(oldEntity.hash);
    if (sameHash && sameHash.id !== oldEntity.id) {
      aliases.push({ previous_id: oldEntity.id, current_id: sameHash.id, reason: "same_hash" });
      continue;
    }
    const samePathName = currentByPathName.get(`${oldEntity.kind}|${oldEntity.path}|${oldEntity.name}`);
    if (samePathName && samePathName.id !== oldEntity.id) {
      aliases.push({ previous_id: oldEntity.id, current_id: samePathName.id, reason: "same_path_name" });
    }
  }
  return aliases;
}

export function buildCodeInventory(root: string, specsDir = "specs", previous?: CodeInventory): CodeInventory & { trace: CodeTraceReport } {
  const resolvedRoot = path.resolve(root);
  const entities: CodeEntity[] = [];
  const files = collectFiles(resolvedRoot);
  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    const fileEntity = addFileEntity(entities, resolvedRoot, file, content);
    const ext = path.extname(file).toLowerCase();
    if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
      extractTypeScript(resolvedRoot, file, content, entities, fileEntity);
    } else if (ext === ".py") {
      extractPython(resolvedRoot, file, content, entities, fileEntity);
    } else if (ext === ".sql") {
      extractSql(resolvedRoot, file, content, entities, fileEntity);
    } else if (CONFIG_FILENAMES.has(path.basename(file))) {
      extractConfig(resolvedRoot, file, content, entities, fileEntity);
    }
    annotateSpecReferences(content, entities, fileEntity.path);
  }
  const languages = [...new Set(entities.map((entity) => entity.language))].sort();
  const specs = loadSpecs(resolvedRoot, specsDir);
  const links = linkEntitiesToSpecs(entities, specs);
  const coverage = summarizeCoverage(entities, links);
  const drift = summarizeDrift(coverage, specs);
  const inventory: CodeInventory = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    root: path.basename(resolvedRoot),
    entity_count: entities.length,
    languages,
    entities,
    coverage,
    drift,
  };
  const linked = new Set(links.map((link) => link.entity_id));
  const trace: CodeTraceReport = {
    schema_version: 1,
    generated_at: inventory.generated_at,
    root: inventory.root,
    specs_dir: specsDir,
    spec_count: specs.length,
    entity_count: inventory.entity_count,
    links,
    unlinked_entities: entities.filter((entity) => governable(entity) && !linked.has(entity.id)).map((entity) => ({
      id: entity.id,
      kind: entity.kind,
      path: entity.path,
      name: entity.name,
      signature: entity.signature,
      start_line: entity.start_line,
    })),
    aliases: aliasChanges(previous, inventory),
    coverage,
    drift,
    embedding_profile: {
      default_scope: ["route", "schema", "command", "config", "class", "function", "method"],
      recommended_fields: ["kind", "path", "name", "signature", "metadata", "linked spec filename", "linked spec sections"],
      notes: "Embed concise structural summaries for code entities separately from full spec-text embeddings.",
    },
  };
  return { ...inventory, trace };
}

export function writeCodeInventory(opts: CodeMapOptions): CodeInventory & { trace: CodeTraceReport } {
  const inventory = buildCodeInventory(opts.root, opts.specsDir ?? "specs", loadPreviousInventory(opts.root, opts.out));
  const target = path.resolve(opts.root, opts.out);
  if (fs.existsSync(target) && !opts.force) {
    throw new Error(`${path.relative(opts.root, target)} already exists. Re-run with --force to overwrite it.`);
  }
  const traceTarget = path.resolve(opts.root, opts.traceOut ?? ".spec/code-trace.json");
  if (fs.existsSync(traceTarget) && !opts.force) {
    throw new Error(`${path.relative(opts.root, traceTarget)} already exists. Re-run with --force to overwrite it.`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const { trace, ...sidecar } = inventory;
  fs.writeFileSync(target, JSON.stringify(sidecar, null, 2) + "\n", "utf8");
  fs.mkdirSync(path.dirname(traceTarget), { recursive: true });
  fs.writeFileSync(traceTarget, JSON.stringify(trace, null, 2) + "\n", "utf8");
  return inventory;
}

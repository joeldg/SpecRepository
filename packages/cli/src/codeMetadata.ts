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

export type CodeEntityKind =
  | "file"
  | "class"
  | "interface"
  | "type"
  | "function"
  | "method"
  | "route"
  | "schema"
  | "index";

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
  metadata?: Record<string, string | number | boolean>;
}

export interface CodeInventory {
  schema_version: 1;
  generated_at: string;
  root: string;
  entity_count: number;
  languages: string[];
  entities: CodeEntity[];
}

export interface CodeMapOptions {
  root: string;
  out: string;
  force: boolean;
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
  metadata?: Record<string, string | number | boolean>;
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
      } else if (CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
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

  function addNode(kind: CodeEntityKind, name: string, node: ts.Node, parentId?: string, metadata?: Record<string, string | number | boolean>): CodeEntity {
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
    if (ts.isClassDeclaration(node) && node.name) {
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
  for (const match of content.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?([A-Za-z_][\w.]*)/gi)) {
    const loc = lineColumnFromOffset(content, match.index ?? 0);
    addEntity(entities, {
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

export function buildCodeInventory(root: string): CodeInventory {
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
    }
  }
  const languages = [...new Set(entities.map((entity) => entity.language))].sort();
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    root: path.basename(resolvedRoot),
    entity_count: entities.length,
    languages,
    entities,
  };
}

export function writeCodeInventory(opts: CodeMapOptions): CodeInventory {
  const inventory = buildCodeInventory(opts.root);
  const target = path.resolve(opts.root, opts.out);
  if (fs.existsSync(target) && !opts.force) {
    throw new Error(`${path.relative(opts.root, target)} already exists. Re-run with --force to overwrite it.`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(inventory, null, 2) + "\n", "utf8");
  return inventory;
}

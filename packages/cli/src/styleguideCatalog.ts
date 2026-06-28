export interface StyleGuideSource {
  title: string;
  url: string;
}

export interface StyleGuideEntry {
  id: string;
  title: string;
  filename: string;
  languages: string[];
  sources: StyleGuideSource[];
}

const GOOGLE_STYLEGUIDE_BASE = "https://google.github.io/styleguide";

export const GOOGLE_STYLE_GUIDES: StyleGuideEntry[] = [
  {
    id: "docguide",
    title: "Google Documentation Guide",
    filename: "google-documentation-guide.md",
    languages: ["Markdown"],
    sources: [
      { title: "Overview", url: `${GOOGLE_STYLEGUIDE_BASE}/docguide/` },
      { title: "Markdown style guide", url: `${GOOGLE_STYLEGUIDE_BASE}/docguide/style.html` },
      { title: "Documentation best practices", url: `${GOOGLE_STYLEGUIDE_BASE}/docguide/best_practices.html` },
      { title: "README files", url: `${GOOGLE_STYLEGUIDE_BASE}/docguide/READMEs.html` },
      { title: "Philosophy", url: `${GOOGLE_STYLEGUIDE_BASE}/docguide/philosophy.html` },
    ],
  },
  {
    id: "typescript",
    title: "Google TypeScript Style Guide",
    filename: "google-typescript-style-guide.md",
    languages: ["TypeScript"],
    sources: [{ title: "TypeScript", url: `${GOOGLE_STYLEGUIDE_BASE}/tsguide.html` }],
  },
  {
    id: "javascript",
    title: "Google JavaScript Style Guide",
    filename: "google-javascript-style-guide.md",
    languages: ["JavaScript"],
    sources: [{ title: "JavaScript", url: `${GOOGLE_STYLEGUIDE_BASE}/jsguide.html` }],
  },
  {
    id: "html-css",
    title: "Google HTML/CSS Style Guide",
    filename: "google-html-css-style-guide.md",
    languages: ["HTML", "CSS"],
    sources: [{ title: "HTML/CSS", url: `${GOOGLE_STYLEGUIDE_BASE}/htmlcssguide.html` }],
  },
  {
    id: "json",
    title: "Google JSON Style Guide",
    filename: "google-json-style-guide.md",
    languages: ["JSON"],
    sources: [{ title: "JSON", url: `${GOOGLE_STYLEGUIDE_BASE}/jsoncstyleguide.xml` }],
  },
  {
    id: "python",
    title: "Google Python Style Guide",
    filename: "google-python-style-guide.md",
    languages: ["Python"],
    sources: [{ title: "Python", url: `${GOOGLE_STYLEGUIDE_BASE}/pyguide.html` }],
  },
  {
    id: "go",
    title: "Google Go Style Guide",
    filename: "google-go-style-guide.md",
    languages: ["Go"],
    sources: [{ title: "Go", url: `${GOOGLE_STYLEGUIDE_BASE}/go/` }],
  },
  {
    id: "java",
    title: "Google Java Style Guide",
    filename: "google-java-style-guide.md",
    languages: ["Java"],
    sources: [{ title: "Java", url: `${GOOGLE_STYLEGUIDE_BASE}/javaguide.html` }],
  },
  {
    id: "cpp",
    title: "Google C++ Style Guide",
    filename: "google-cpp-style-guide.md",
    languages: ["C++", "C"],
    sources: [{ title: "C++", url: `${GOOGLE_STYLEGUIDE_BASE}/cppguide.html` }],
  },
  {
    id: "csharp",
    title: "Google C# Style Guide",
    filename: "google-csharp-style-guide.md",
    languages: ["C#"],
    sources: [{ title: "C#", url: `${GOOGLE_STYLEGUIDE_BASE}/csharp-style.html` }],
  },
  {
    id: "shell",
    title: "Google Shell Style Guide",
    filename: "google-shell-style-guide.md",
    languages: ["Shell"],
    sources: [{ title: "Shell", url: `${GOOGLE_STYLEGUIDE_BASE}/shellguide.html` }],
  },
  {
    id: "swift",
    title: "Google Swift Style Guide",
    filename: "google-swift-style-guide.md",
    languages: ["Swift"],
    sources: [{ title: "Swift", url: `${GOOGLE_STYLEGUIDE_BASE}/swiftguide.html` }],
  },
];

function normalizeLanguage(language: string): string {
  const v = language.trim().toLowerCase();
  const aliases: Record<string, string> = {
    js: "javascript",
    ts: "typescript",
    py: "python",
    golang: "go",
    "c++": "c++",
    cpp: "c++",
    "c#": "c#",
    csharp: "c#",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
  };
  return aliases[v] ?? v;
}

export function styleGuidesForLanguages(languages: string[]): StyleGuideEntry[] {
  const wanted = new Set(languages.map(normalizeLanguage));
  return GOOGLE_STYLE_GUIDES.filter((guide) =>
    guide.languages.some((lang) => wanted.has(normalizeLanguage(lang)))
  );
}

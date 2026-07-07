"use client";

import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { safeMarkdownUrl } from "./safe-markdown-url";

const ALLOWED_MARKDOWN_ELEMENTS = [
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "img",
  "input",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
];

const components: Components = {
  a({ href, children, ...props }) {
    const safeHref = safeMarkdownUrl(String(href || ""));
    if (!safeHref) return <span>{children}</span>;
    return (
      <a {...props} href={safeHref} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  },
  img({ src, alt, ...props }) {
    const safeSrc = safeMarkdownUrl(String(src || ""));
    if (!safeSrc) return null;
    // eslint-disable-next-line @next/next/no-img-element
    return <img {...props} src={safeSrc} alt={alt || ""} loading="lazy" referrerPolicy="no-referrer" />;
  },
};

export function SafeMarkdown({ children }: { children: ReactNode }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      allowedElements={ALLOWED_MARKDOWN_ELEMENTS}
      unwrapDisallowed
      urlTransform={safeMarkdownUrl}
      components={components}
    >
      {String(children ?? "")}
    </ReactMarkdown>
  );
}

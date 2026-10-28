import assert from "node:assert/strict";
import test from "node:test";
import { findFirstUrl, parseLinkMetadata } from "./link-metadata.ts";

test("reads the Open Graph title and resolves a relative icon against the page", () => {
  const html = `<html><head><meta property="og:title" content="Docs &amp; API">
    <link rel="shortcut icon" href="/static/icon.png"><title>ignored</title></head></html>`;

  assert.deepEqual(parseLinkMetadata(html, "https://example.com/guide/start"), {
    title: "Docs & API",
    faviconUrl: "https://example.com/static/icon.png",
  });
});

test("falls back to the document title and the site root favicon", () => {
  assert.deepEqual(parseLinkMetadata("<title> Status page </title>", "https://status.example.com/a"), {
    title: "Status page",
    faviconUrl: "https://status.example.com/favicon.ico",
  });
});

test("finds the first URL in free text without trailing punctuation", () => {
  assert.equal(
    findFirstUrl("check https://github.com/acme/app/pull/3, then ship."),
    "https://github.com/acme/app/pull/3",
  );
});

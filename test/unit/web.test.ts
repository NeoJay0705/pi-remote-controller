import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Message, textContent } from "../../src/web/Message.js";
import { mergeActiveHistory } from "../../src/web/api.js";

describe("active history merge", () => {
  it("keeps only confirmed ancestors when the native branch changes", () => {
    const old = [
      { id: "root", parentId: null, type: "message" },
      { id: "old-branch", parentId: "root", type: "message" },
      { id: "new-parent", parentId: "root", type: "message" },
    ];
    expect(
      mergeActiveHistory(old, [
        { id: "new-head", parentId: "new-parent", type: "message" },
      ]).map((entry) => entry.id),
    ).toEqual(["root", "new-parent", "new-head"]);
    expect(mergeActiveHistory(old, [])).toEqual([]);
  });
  it("prepends an older page without dropping the current page", () => {
    const older = [
      { id: "oldest", parentId: null, type: "message" },
      { id: "middle", parentId: "oldest", type: "message" },
    ];
    const current = [
      { id: "recent", parentId: "middle", type: "message" },
      { id: "latest", parentId: "recent", type: "message" },
    ];
    expect(mergeActiveHistory(older, current).map((entry) => entry.id)).toEqual(
      ["oldest", "middle", "recent", "latest"],
    );
  });
  it("appends a new page after shared ancestors", () => {
    const old = [
      { id: "root", parentId: null, type: "message" },
      { id: "branch", parentId: "root", type: "message" },
    ];
    expect(
      mergeActiveHistory(old, [
        { id: "next", parentId: "branch", type: "message" },
      ]).map((entry) => entry.id),
    ).toEqual(["root", "branch", "next"]);
  });
});

describe("safe web message rendering", () => {
  it("does not render raw HTML or request markdown images", () => {
    const malicious = renderToStaticMarkup(
      createElement(Message, { children: "<script>alert(1)</script>" }),
    );
    const image = renderToStaticMarkup(
      createElement(Message, {
        children: "![x](https://invalid.example/pixel.png)",
      }),
    );
    expect(malicious).not.toContain("<script");
    expect(image).not.toContain("https://invalid.example");
    expect(image).toContain("圖片省略");
  });
  it("marks truncated text rather than silently dropping it", () => {
    const value = textContent("x".repeat(30001));
    expect(value).toContain("[內容已截斷]");
    expect(value.length).toBeLessThan(30100);
  });
});

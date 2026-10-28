import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RoomGoneScreen } from "../apps/web/src/App";
import { english, spanish } from "../apps/web/src/localization";

describe("unavailable rooms", () => {
  it("explains restart invalidation and that local history remains available", () => {
    expect(english.roomNotFound).toMatch(/restart/);
    expect(english.roomNotFound).toMatch(/new room/);
    expect(english.roomNotFound).toMatch(/local.*history/i);
    expect(spanish.roomNotFound).toMatch(/reinicio/);
  });

  it("offers a local history entry alongside creating a new room", () => {
    const html = renderToStaticMarkup(createElement(RoomGoneScreen, {
      fromInvite: false,
      reason: english.roomNotFound,
      onViewHistory: () => {},
      historyLoaded: true
    }));
    expect(html).toContain('查看本地记录');
    expect(html).toContain('href="/"');
    expect(html).not.toContain('disabled');
  });

  it("waits for local history to load before allowing it to open", () => {
    const html = renderToStaticMarkup(createElement(RoomGoneScreen, {
      fromInvite: true,
      onViewHistory: () => {},
      historyLoaded: false
    }));
    expect(html).toContain('disabled');
    expect(html).toContain('href="/?source=invite"');
  });
});

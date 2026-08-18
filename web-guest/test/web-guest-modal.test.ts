import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../public/join.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/app.css", import.meta.url), "utf8");

describe("Web Guest 上传状态弹窗", () => {
  it("使用不可忽略的无障碍模态结构，并提供结果确认按钮", () => {
    expect(html).toContain('id="message-dialog"');
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="message-dialog-title"');
    expect(html).toContain('aria-describedby="message-dialog-detail"');
    expect(html).toContain('id="message-dialog-action"');
    expect(styles).toMatch(/\.modal\s*\{[^}]*position:\s*fixed;/s);
    expect(styles).toContain(".modal[hidden]");
  });

  it("从上传开始到 finalize 完成持续显示忙碌提示", () => {
    const sendingStart = script.indexOf("state.isSending = true");
    const busyDialog = script.indexOf('title: "Sending your message"', sendingStart);
    const audioUpload = script.indexOf('upload("audio"', sendingStart);
    const finalize = script.indexOf("/finalize", audioUpload);
    const successDialog = script.indexOf('title: "Message sent securely"', finalize);
    const sendingEnd = script.indexOf("state.isSending = false", successDialog);

    expect(sendingStart).toBeGreaterThan(-1);
    expect(busyDialog).toBeGreaterThan(sendingStart);
    expect(audioUpload).toBeGreaterThan(busyDialog);
    expect(finalize).toBeGreaterThan(audioUpload);
    expect(successDialog).toBeGreaterThan(finalize);
    expect(sendingEnd).toBeGreaterThan(successDialog);
    expect(script.slice(busyDialog, audioUpload)).toContain("busy: true");
  });

  it("失败时保留重试入口，且仅在实际上传期间启用离页保护", () => {
    expect(script).toContain('title: "Upload not finished"');
    expect(script).toContain('actionLabel: "Close"');
    expect(script).toContain("tap Send to host to try again");
    expect(script).toContain('$("send").disabled = false');
    expect(script).toMatch(/beforeunload[\s\S]*if \(!state\.isSending\) return;[\s\S]*event\.preventDefault\(\);[\s\S]*event\.returnValue = "";/);
    expect(script).not.toContain("window.alert(");
    expect(script).not.toContain("window.confirm(");
  });
});

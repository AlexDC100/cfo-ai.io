// Pricing V3 (refined spec §14) — proves the chat composer hard-disables
// itself when a chat cap has been reached. Spec literal:
//   "Chat input server-checks cap before send (disable + message if
//    blocked, no generic error)."
//
// The backend already enforces the cap atomically via reserve_user_chat
// (proven by tests/test_pricing_v3_atomicity.py). This file proves the
// frontend honors the server's 429 by:
//   1. Rendering a visible banner with the headline + body + link
//   2. Disabling the textarea so the user can't keep retyping
//   3. Disabling the send + attach buttons
//
// Without this guard, a user who hits their cap can hammer Enter
// repeatedly and produce a stream of 429-card replies — spec §14
// explicitly forbids that pattern.

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { CFOComposer } from "../CFOComposer";

describe("CFOComposer — chat-cap blocked state (spec §14)", () => {
  it("renders the blocked banner with headline, body, and link", () => {
    render(
      <CFOComposer
        pending={false}
        onSubmit={vi.fn()}
        blockedReason={{
          headline: "Daily Ask CFO AI limit reached",
          body: "You've hit your plan's chat cap. It resets at midnight UTC.",
          href: "/pricing",
        }}
      />,
    );

    const banner = screen.getByTestId("chat-blocked-banner");
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain("Daily Ask CFO AI limit reached");
    expect(banner.textContent).toContain("resets at midnight UTC");

    const link = banner.querySelector("a[href='/pricing']");
    expect(link).toBeTruthy();
    // Link label is i18n'd (chatX.seePlans) — assert it renders non-empty
    // rather than pinning the English literal.
    expect((link?.textContent ?? "").length).toBeGreaterThan(0);
  });

  it("disables the textarea, attach, and send buttons when blocked", () => {
    render(
      <CFOComposer
        pending={false}
        onSubmit={vi.fn()}
        blockedReason={{
          headline: "Monthly Ask CFO AI limit reached",
          body: "Resets at the start of your next billing period.",
          href: "/pricing",
        }}
      />,
    );

    const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    // Placeholder copy is i18n'd (chatX.pausedPlaceholder) — assert the
    // blocked-state placeholder is present rather than pinning the English
    // literal (tests run without an initialized i18n instance).
    expect(textarea.placeholder.length).toBeGreaterThan(0);

    const attach = screen.getByTestId("chat-attach") as HTMLButtonElement;
    expect(attach.disabled).toBe(true);

    const send = screen.getByTestId("chat-send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });

  it("does NOT fire onSubmit when the user attempts to send while blocked", () => {
    const onSubmit = vi.fn();
    render(
      <CFOComposer
        pending={false}
        onSubmit={onSubmit}
        blockedReason={{
          headline: "Daily Ask CFO AI limit reached",
          body: "Resets at midnight UTC.",
          href: "/pricing",
        }}
      />,
    );

    // Synthesize a click on the (disabled) send button — disabled buttons
    // don't dispatch click handlers, so this asserts the disabled state
    // actually prevents submission rather than relying solely on the
    // `disabled` attribute being present.
    const send = screen.getByTestId("chat-send") as HTMLButtonElement;
    send.click();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("renders normally (no banner, inputs enabled) when blockedReason is null", () => {
    render(<CFOComposer pending={false} onSubmit={vi.fn()} blockedReason={null} />);
    expect(screen.queryByTestId("chat-blocked-banner")).toBeNull();

    const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);
  });
});

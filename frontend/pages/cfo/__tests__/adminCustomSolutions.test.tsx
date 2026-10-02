// Admin page — only an operator sees it; linking and unlinking an account
// go through the engine and the list shows the engine's answer.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import i18n from "@/i18n";
import { renderWithProviders } from "@/test/renderWithProviders";

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "admin-1" } }) }));

const state = vi.hoisted(() => ({ isAdmin: true }));
const api = vi.hoisted(() => {
  const automasters = (accounts: unknown[]) => ({
    solutions: [{ key: "automasters", name: "AutoMasters", description: "Dealership finance", accounts }],
  });
  const linked = { user_id: "u-2", email: "finance@automasters.ro", granted_at: "2026-10-02T10:00:00Z", granted_by_email: "op@cfo-ai.io", note: "CFO" };
  return {
    automasters,
    linked,
    list: vi.fn(async () => automasters([])),
    link: vi.fn(async () => ({ ok: true, ...automasters([linked]) })),
    unlink: vi.fn(async () => ({ ok: true, ...automasters([]) })),
  };
});

vi.mock("@/lib/customSolutions", async (orig) => ({
  ...(await orig<typeof import("@/lib/customSolutions")>()),
  usePlatformAdmin: () => ({ isAdmin: state.isAdmin, loading: false }),
  useInvalidateSolutions: () => () => Promise.resolve(),
  adminApi: { list: api.list, link: api.link, unlink: api.unlink },
}));

import Admin from "../Admin";

beforeEach(async () => {
  await i18n.changeLanguage("en");
  state.isAdmin = true;
  api.list.mockClear();
  api.link.mockClear();
  api.unlink.mockClear();
});

describe("Admin · custom solutions", () => {
  it("a non-operator sees a refusal and nothing is fetched", () => {
    state.isAdmin = false;
    renderWithProviders(<Admin />);
    expect(screen.getByText("Admins only")).toBeTruthy();
    expect(api.list).not.toHaveBeenCalled();
  });

  it("lists AutoMasters, links an account by e-mail, then unlinks it after a confirm", async () => {
    renderWithProviders(<Admin />);
    await waitFor(() => expect(screen.getByText("AutoMasters")).toBeTruthy());
    expect(screen.getByText("No accounts linked yet.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Account e-mail"), { target: { value: "finance@automasters.ro" } });
    fireEvent.change(screen.getByLabelText("Note (optional)"), { target: { value: "CFO" } });
    fireEvent.click(screen.getByRole("button", { name: /Link account/ }));
    await waitFor(() => expect(api.link).toHaveBeenCalledWith("automasters", "finance@automasters.ro", "CFO"));
    await waitFor(() => expect(screen.getByText("finance@automasters.ro")).toBeTruthy());
    expect(screen.getByText("1 linked account")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Unlink/ }));
    expect(screen.getByText("Remove access?")).toBeTruthy();
    expect(api.unlink).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: /Unlink/ })[0]);
    await waitFor(() => expect(api.unlink).toHaveBeenCalledWith("automasters", "u-2"));
    await waitFor(() => expect(screen.getByText("No accounts linked yet.")).toBeTruthy());
  });
});

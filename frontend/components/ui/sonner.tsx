import { useTheme } from "next-themes";
import { Toaster as Sonner, toast } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      // Always render every toast in full. Sonner's default is the
      // collapsed stack — the newest toast on top with the rest peeking
      // behind it as slivers, expanding only on hover — which meant two
      // toasts fired close together produced two different-looking
      // notifications depending on timing, and the older one was
      // unreadable until moused over. `expand` pins it to the
      // one-card-per-toast list in every case.
      expand
      // With nothing collapsing, an unbounded list could run off-screen;
      // sonner's default cap is 3, which is low once expanded.
      visibleToasts={5}
      toastOptions={{
        classNames: {
          // !important-flagged app tokens — the previous group-[.toaster]
          // recipe lost to sonner's own styles and rendered bare text with
          // no background (2026-07-23 fix).
          toast:
            "!bg-surface !text-ink !border !border-rule !shadow-xl !rounded-xl",
          title: "!text-ink !font-semibold",
          description: "!text-ink-soft",
          actionButton: "!bg-brand !text-bg !font-medium",
          cancelButton: "!bg-bg-2 !text-ink-soft",
          success: "!bg-surface !text-ink !border-brand/40",
          error: "!bg-surface !text-ink !border-alert/40",
          warning: "!bg-surface !text-ink !border-caution/40",
          info: "!bg-surface !text-ink !border-rule",
        },
      }}
      {...props}
    />
  );
};

export { Toaster, toast };

import { useTheme } from "next-themes";
import { Toaster as Sonner, toast } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
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

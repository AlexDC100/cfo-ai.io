import type { Bucket } from "@/lib/cfoApi";
import { BUCKET_LABEL, BUCKET_CHIP_CLASS } from "@/lib/buckets";

export function BucketChip({ bucket, size = "sm" }: { bucket: Bucket; size?: "sm" | "md" }) {
  const sizeClass = size === "md" ? "text-[12px] px-2.5 py-0.5" : "";
  return (
    <span className={`${BUCKET_CHIP_CLASS[bucket]} ${sizeClass}`}>
      {BUCKET_LABEL[bucket]}
    </span>
  );
}

import { Input } from "./ui/input";
export function LabelText({
  label,
  ...props
}: { label: string } & React.ComponentProps<typeof Input>) {
  return (
    <label className="flex flex-col gap-2 text-sm">
      {label}
      <Input {...props} />
    </label>
  );
}
export function MoneyField({
  label,
  value,
  onChange,
  min,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  min: string;
}) {
  return (
    <label className="flex flex-col gap-2 text-sm">
      {label}
      <Input
        type="number"
        min={min}
        max="200"
        step="0.01"
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-44"
      />
    </label>
  );
}

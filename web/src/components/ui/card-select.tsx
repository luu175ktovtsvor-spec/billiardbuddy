"use client";

interface CardSelectOption {
  value: string;
  label: string;
  emoji?: string;
  desc?: string;
}

interface CardSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: CardSelectOption[];
  columns?: 2 | 3 | 4;
}

export function CardSelect({ value, onChange, options, columns = 3 }: CardSelectProps) {
  const gridClass = {
    2: "grid-cols-2",
    3: "grid-cols-3",
    4: "grid-cols-4",
  }[columns];

  return (
    <div className={`grid ${gridClass} gap-2.5`}>
      {options.map((opt) => {
        const selected = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`flex min-h-[60px] flex-col items-center justify-center gap-0.5 rounded-2xl p-3 text-center transition-all active:scale-[0.97] ${
              selected
                ? "bg-brand-50 ring-2 ring-brand-500"
                : "bg-slate-50 ring-1 ring-transparent active:bg-slate-100"
            }`}
          >
            {opt.emoji && <span className="text-xl leading-none">{opt.emoji}</span>}
            <span className={`text-sm font-medium ${selected ? "text-brand-700" : "text-slate-700"}`}>
              {opt.label}
            </span>
            {opt.desc && (
              <span className={`text-xs leading-tight ${selected ? "text-brand-500" : "text-slate-400"}`}>
                {opt.desc}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

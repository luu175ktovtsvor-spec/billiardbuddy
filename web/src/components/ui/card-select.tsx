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
    <div className={`grid ${gridClass} gap-2`}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`flex flex-col items-center gap-0.5 rounded-lg border-2 p-3 text-center transition-all ${
            value === opt.value
              ? "border-indigo-500 bg-indigo-50 shadow-sm"
              : "border-slate-200 bg-white hover:border-slate-300 hover:shadow-sm"
          }`}
        >
          {opt.emoji && <span className="text-lg">{opt.emoji}</span>}
          <span className={`text-sm font-medium ${
            value === opt.value ? "text-indigo-700" : "text-slate-700"
          }`}>{opt.label}</span>
          {opt.desc && <span className="text-xs text-slate-400 leading-tight">{opt.desc}</span>}
        </button>
      ))}
    </div>
  );
}

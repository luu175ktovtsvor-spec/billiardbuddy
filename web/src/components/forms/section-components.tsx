export function Section({ title, icon: Icon, children }: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl bg-white p-4 sm:p-6 shadow-sm">
      <div className="mb-4 flex items-center gap-2 border-b border-slate-100 pb-3">
        <Icon className="h-4 w-4 text-slate-500" />
        <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

export function Field({ label, required, children }: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-slate-700">
        {label} {required && <span className="text-red-600">*</span>}
      </label>
      {children}
    </div>
  );
}

export function Toggle({ label, checked, onChange }: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`flex w-full items-center justify-between gap-3 rounded-xl px-3.5 py-2.5 text-left transition-all active:scale-[0.99] ${
        checked ? "bg-brand-50 ring-1 ring-brand-200" : "bg-slate-50 ring-1 ring-transparent active:bg-slate-100"
      }`}
    >
      <span className={`text-sm ${checked ? "font-medium text-brand-700" : "text-slate-600"}`}>{label}</span>
      <span className={`relative h-[26px] w-[42px] shrink-0 rounded-full transition-colors ${checked ? "bg-brand-500" : "bg-slate-300"}`}>
        <span className={`absolute top-0.5 h-[22px] w-[22px] rounded-full bg-white shadow transition-all ${checked ? "left-[18px]" : "left-0.5"}`} />
      </span>
    </button>
  );
}

export function TagGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-2">{children}</div>
  );
}

export function TagCheckbox({ label, checked, onChange }: {
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      className={`inline-flex items-center rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-all active:scale-[0.96] ${
        checked
          ? "bg-brand-600 text-white shadow-sm"
          : "bg-slate-100 text-slate-500 active:bg-slate-200"
      }`}
    >
      {label}
    </button>
  );
}

interface Props {
  ok: boolean;
  known?: boolean;
  label?: string;
}

export function StatusBadge({ ok, known = true, label }: Props) {
  const state = !known ? "unknown" : ok ? "ok" : "fail";
  const text = label ?? (!known ? "no health data" : ok ? "healthy" : "unhealthy");
  return (
    <span className={`badge badge--${state}`}>
      <span className="badge__dot" aria-hidden="true" />
      {text}
    </span>
  );
}

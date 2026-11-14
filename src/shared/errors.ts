/** Коротко про помилку запуску: повний текст (кілька монет, адреси) ховається під «Деталі». */
export function errorSummary(error: string | null): string {
  if (!error) return "";
  const parts = error.split("; ").filter(Boolean);
  if (/too many subrequests/i.test(error)) {
    return "Cloudflare обмежив кількість запитів за один запуск: потрібен план Workers Paid.";
  }
  if (/заборонена локація|HTTP 451|HTTP 403/.test(error)) return "біржа недоступна з дата-центру рушія.";
  const first = parts[0]!.length > 120 ? `${parts[0]!.slice(0, 120)}…` : parts[0]!;
  return parts.length > 1 ? `${first} (і ще ${parts.length - 1})` : first;
}

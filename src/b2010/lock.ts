/** Один активний торговий процес на акаунт і символ: файл-замок із PID. Застарілий замок (процесу немає) знімається. */
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

export function acquireLock(path: string): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          unlinkSync(path);
        } catch {}
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = Number(readFileSync(path, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) throw new Error(`уже працює інший процес бота (PID ${pid}, замок ${path})`);
      unlinkSync(path);
    }
  }
  throw new Error(`не вдалося взяти замок ${path}`);
}

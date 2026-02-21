/**
 * claudeoo stats command — show aggregate usage statistics.
 */

import { getStats } from "./db";
import { formatStats } from "./format";

export function runStats(range: "today" | "week" | "all"): void {
  let since: string | undefined;
  let label: string;

  const now = new Date();
  switch (range) {
    case "today": {
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      since = today.toISOString();
      label = "today";
      break;
    }
    case "week": {
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      since = weekAgo.toISOString();
      label = "last 7 days";
      break;
    }
    case "all":
      since = undefined;
      label = "all time";
      break;
  }

  const stats = getStats(since);
  console.log(formatStats(stats, label));
}

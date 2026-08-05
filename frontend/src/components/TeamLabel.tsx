import ManagerAvatar from "./ManagerAvatar";

/**
 * A team name with its manager's avatar and username.
 *
 * Team names change; usernames don't. Showing both means a squad is always
 * traceable to a person, which matters most in trades and matchup history.
 */
export default function TeamLabel({
  name,
  username,
  avatarUrl,
  align = "left",
  showAvatar = true,
  className = "",
}: {
  name: string | undefined;
  username: string | null | undefined;
  avatarUrl?: string | null;
  align?: "left" | "right";
  showAvatar?: boolean;
  className?: string;
}) {
  const text = (
    <span className={`flex min-w-0 flex-col ${align === "right" ? "items-end" : ""}`}>
      <span className="truncate">{name ?? "—"}</span>
      {username ? (
        <span className="truncate text-xs text-[var(--text-dim)]">@{username}</span>
      ) : null}
    </span>
  );

  if (!showAvatar) {
    return <span className={`flex min-w-0 ${className}`}>{text}</span>;
  }

  return (
    <span
      className={`flex min-w-0 items-center gap-2 ${
        align === "right" ? "flex-row-reverse" : ""
      } ${className}`}
    >
      <ManagerAvatar src={avatarUrl} username={username} />
      {text}
    </span>
  );
}

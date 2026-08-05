"use client";

import { useEffect, useRef, useState } from "react";

import ManagerAvatar from "@/components/ManagerAvatar";
import { createClient } from "@/lib/supabase/client";

export type ChatMessage = {
  id: string;
  fantasy_team_id: string;
  author_id: string;
  body: string;
  created_at: string;
};

type TeamInfo = { name: string; username: string | null; avatarUrl: string | null };

type Props = {
  leagueId: string;
  teamId: string;
  userId: string;
  teams: Record<string, TeamInfo>;
  initial: ChatMessage[];
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Hand-rolled rather than toLocaleString: Node and mobile Safari ship
 * different Intl data, so the same timestamp rendered "5 Aug, 15:22" on the
 * server and "5 Aug at 15:22" on the client — a genuine hydration mismatch.
 */
function timeLabel(value: string) {
  const date = new Date(value);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${hours}:${minutes}`;
}

export default function ChatRoom({ leagueId, teamId, userId, teams, initial }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>(initial);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("connecting");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel(`chat:${leagueId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "league_messages",
          filter: `league_id=eq.${leagueId}`,
        },
        (payload) => {
          const incoming = payload.new as ChatMessage;
          // The sender already added it optimistically.
          setMessages((current) =>
            current.some((message) => message.id === incoming.id)
              ? current
              : [...current, incoming],
          );
        },
      )
      .subscribe((state, subscribeError) => {
        setStatus(state);
        if (subscribeError) {
          // Usually means league_messages isn't in the supabase_realtime publication.
          console.error(`[realtime] chat ${state}`, subscribeError);
        }
      });

    // A backgrounded tab can miss messages while its socket is throttled, so
    // refetch history when it comes back rather than assuming it kept up.
    const resync = async () => {
      if (document.visibilityState !== "visible") return;

      const { data } = await supabase
        .from("league_messages")
        .select("id, fantasy_team_id, author_id, body, created_at")
        .eq("league_id", leagueId)
        .order("created_at", { ascending: false })
        .limit(100);

      if (data) setMessages((data as ChatMessage[]).slice().reverse());
    };

    document.addEventListener("visibilitychange", resync);
    window.addEventListener("focus", resync);

    // Safety net for mobile browsers, which suspend pages and can leave a
    // socket that reports healthy but delivers nothing. Chat polls faster than
    // the other pages because a late message is more obvious than a late score.
    const timer = setInterval(resync, 8000);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", resync);
      window.removeEventListener("focus", resync);
      void supabase.removeChannel(channel);
    };
  }, [leagueId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;

    setSending(true);
    setError(null);

    const supabase = createClient();
    const { data, error: insertError } = await supabase
      .from("league_messages")
      .insert({ league_id: leagueId, fantasy_team_id: teamId, author_id: userId, body })
      .select("id, fantasy_team_id, author_id, body, created_at")
      .single();

    if (insertError) {
      setError(insertError.message);
    } else {
      setDraft("");
      if (data) {
        setMessages((current) =>
          current.some((message) => message.id === data.id)
            ? current
            : [...current, data as ChatMessage],
        );
      }
    }

    setSending(false);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex max-h-[60vh] min-h-[16rem] flex-col gap-3 overflow-y-auto rounded-lg border border-[var(--border)] p-4">
        {messages.length === 0 ? (
          <p className="m-auto text-sm text-[var(--text-dim)]">Nothing said yet.</p>
        ) : null}

        {messages.map((message) => {
          const mine = message.author_id === userId;
          const team = teams[message.fantasy_team_id];

          return (
            <div
              key={message.id}
              className={`flex max-w-[90%] items-start gap-2 ${
                mine ? "flex-row-reverse self-end text-right" : "self-start"
              }`}
            >
              <ManagerAvatar src={team?.avatarUrl} username={team?.username} />
              <div className="min-w-0">
                {/* suppressHydrationWarning: the server and the reader can sit
                    in different timezones, so the rendered time legitimately
                    differs. The client's version is the correct one. */}
                <p className="text-xs text-[var(--text-dim)]" suppressHydrationWarning>
                  {team?.name ?? "Unknown team"}
                  {team?.username ? ` · @${team.username}` : ""} · {timeLabel(message.created_at)}
                </p>
                <p
                  className={`mt-0.5 inline-block max-w-[36rem] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                    mine
                      ? "bg-[var(--accent-soft)] text-[var(--text)]"
                      : "bg-[var(--surface)] text-[var(--text)]"
                  }`}
                >
                  {message.body}
                </p>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {status !== "SUBSCRIBED" && status !== "connecting" ? (
        <p className="text-xs text-[var(--text-dim)]">
          Reconnecting… messages may be delayed.
        </p>
      ) : null}

      {error ? <p className="notice notice-error">{error}</p> : null}

      {/* suppressHydrationWarning: browser autofill stamps attributes onto the
          form before React hydrates. */}
      <form onSubmit={send} className="flex gap-2" suppressHydrationWarning>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Say something"
          maxLength={2000}
          className="input flex-1"
          suppressHydrationWarning
        />
        <button className="btn btn-primary" disabled={sending || draft.trim().length === 0}>
          Send
        </button>
      </form>
    </div>
  );
}

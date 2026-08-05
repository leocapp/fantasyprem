"use client";

import { useEffect, useRef, useState } from "react";

import { createClient } from "@/lib/supabase/client";

export type ChatMessage = {
  id: string;
  fantasy_team_id: string;
  author_id: string;
  body: string;
  created_at: string;
};

type Props = {
  leagueId: string;
  teamId: string;
  userId: string;
  teamNames: Record<string, string>;
  initial: ChatMessage[];
};

function timeLabel(value: string) {
  return new Date(value).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ChatRoom({ leagueId, teamId, userId, teamNames, initial }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>(initial);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      .subscribe();

    return () => {
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

          return (
            <div key={message.id} className={mine ? "self-end text-right" : "self-start"}>
              <p className="text-xs text-[var(--text-dim)]">
                {teamNames[message.fantasy_team_id] ?? "Unknown team"} · {timeLabel(message.created_at)}
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
          );
        })}
        <div ref={bottomRef} />
      </div>

      {error ? <p className="notice notice-error">{error}</p> : null}

      <form onSubmit={send} className="flex gap-2">
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

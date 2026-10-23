import type { PrismaClient } from "@prisma/client";
import { fail } from "./core.js";

type ReadField = "studentReadAt" | "staffReadAt";
interface ThreadLike {
  messages: { authorId: string; createdAt: Date }[];
}

/** A thread is unread when the other side wrote after the reader's last read point. */
export function unreadFor(
  thread: ThreadLike,
  readAt: Date | null | undefined,
  fromOtherSide: (authorId: string) => boolean,
) {
  return thread.messages.some(
    (message) =>
      fromOtherSide(message.authorId) &&
      (!readAt || message.createdAt.getTime() > readAt.getTime()),
  );
}

/**
 * Marks a thread read up to the last message the reader actually saw, so a reply that
 * arrives while the thread is open stays unread. The read point only ever moves forward.
 */
export async function markThreadRead(
  db: PrismaClient,
  threadId: string,
  upTo: string,
  field: ReadField,
  studentId?: string,
) {
  const thread = await db.thread.findFirst({
    where: { id: threadId, ...(studentId ? { studentId } : {}) },
  });
  if (!thread) fail(404, "NOT_FOUND", "Conversation not found.");
  const message = await db.message.findFirst({
    where: { id: upTo, threadId },
  });
  if (!message) fail(404, "NOT_FOUND", "Message not found in this conversation.");
  const current = thread[field];
  if (!current || current.getTime() < message.createdAt.getTime())
    await db.thread.update({
      where: { id: threadId },
      data: { [field]: message.createdAt },
    });
  return {
    threadId,
    readAt: (current && current > message.createdAt
      ? current
      : message.createdAt
    ).toISOString(),
  };
}

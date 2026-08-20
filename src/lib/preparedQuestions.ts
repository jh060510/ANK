import type { PreparedQuestion } from '../types'

export const PREPARED_QUESTION_SLOT_COUNT = 20
export const DEFAULT_PREPARED_QUESTION_SLOT_COUNT = 6

export type PreparedQuestionSlot = {
  number: number
  question: PreparedQuestion | null
}

function validSlot(value: number | undefined): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= PREPARED_QUESTION_SLOT_COUNT
}

export function resolvePreparedSlotCount(
  questions: PreparedQuestion[],
  requestedCount?: number,
): number {
  const highestOccupiedSlot = questions
    .slice(0, PREPARED_QUESTION_SLOT_COUNT)
    .reduce((highest, question, index) => (
      Math.max(highest, validSlot(question.slot) ? question.slot : index + 1)
    ), 1)
  const normalizedRequested = Number.isInteger(requestedCount)
    ? Math.min(PREPARED_QUESTION_SLOT_COUNT, Math.max(1, Number(requestedCount)))
    : DEFAULT_PREPARED_QUESTION_SLOT_COUNT
  return Math.max(highestOccupiedSlot, normalizedRequested)
}

export function arrangePreparedQuestionSlots(
  questions: PreparedQuestion[],
): PreparedQuestionSlot[] {
  const arranged: Array<PreparedQuestion | null> = Array(PREPARED_QUESTION_SLOT_COUNT).fill(null)
  const unassigned: PreparedQuestion[] = []

  questions.slice(0, PREPARED_QUESTION_SLOT_COUNT).forEach((question) => {
    if (validSlot(question.slot) && !arranged[question.slot - 1]) {
      arranged[question.slot - 1] = { ...question, slot: question.slot }
    } else {
      unassigned.push(question)
    }
  })

  unassigned.forEach((question) => {
    const emptyIndex = arranged.findIndex((candidate) => !candidate)
    if (emptyIndex >= 0) arranged[emptyIndex] = { ...question, slot: emptyIndex + 1 }
  })

  return arranged.map((question, index) => ({ number: index + 1, question }))
}

export function upsertPreparedQuestionSlot(
  questions: PreparedQuestion[],
  slotNumber: number,
  question: PreparedQuestion,
): PreparedQuestion[] {
  const slots = arrangePreparedQuestionSlots(questions)
  if (!validSlot(slotNumber)) {
    return slots.flatMap((slot) => slot.question ? [{ ...slot.question, slot: slot.number }] : [])
  }
  slots[slotNumber - 1] = {
    number: slotNumber,
    question: { ...question, slot: slotNumber },
  }
  return slots.flatMap((slot) => slot.question ? [{ ...slot.question, slot: slot.number }] : [])
}

export function clearPreparedQuestionSlot(
  questions: PreparedQuestion[],
  slotNumber: number,
): PreparedQuestion[] {
  const slots = arrangePreparedQuestionSlots(questions)
  if (validSlot(slotNumber)) slots[slotNumber - 1] = { number: slotNumber, question: null }
  return slots.flatMap((slot) => slot.question ? [{ ...slot.question, slot: slot.number }] : [])
}

export function summarizePreparedQuestion(question: PreparedQuestion | null): string {
  if (!question) return '비어 있음'
  const text = (question.ko || question.en).replace(/\s+/g, ' ').trim()
  return text.length > 42 ? `${text.slice(0, 41)}…` : text
}

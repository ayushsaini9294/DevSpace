import { describe, expect, it } from 'vitest';
import {
  allowedTaskMoves,
  ConfirmTaskDoneRequestSchema,
  CreateTaskRequestSchema,
  MAX_TASK_ASSIGNEES,
  MoveTaskRequestSchema,
  TaskViewSchema,
  UpdateTaskRequestSchema,
} from './tasks.ts';

describe('CreateTaskRequestSchema', () => {
  it('accepts a title, assignees and an optional description and due date', () => {
    expect(CreateTaskRequestSchema.parse({ title: '  Login  ', assigneeIds: ['u1'] })).toEqual({
      title: 'Login',
      description: '',
      assigneeIds: ['u1'],
    });
    expect(
      CreateTaskRequestSchema.parse({ title: 'x', assigneeIds: ['u1'], dueDate: '2026-10-01' })
        .dueDate,
    ).toBe('2026-10-01');
    expect(
      CreateTaskRequestSchema.parse({ title: 'x', assigneeIds: ['u1'], dueDate: null }).dueDate,
    ).toBeNull();
  });

  it('rejects bad titles, assignees, descriptions and dates', () => {
    const bad = [
      { title: ' ', assigneeIds: ['u1'] },
      { title: 'x'.repeat(201), assigneeIds: ['u1'] },
      { title: 'x', assigneeIds: [] },
      { title: 'x' },
      { title: 'x', assigneeIds: ['u1', 'u1'] },
      {
        title: 'x',
        assigneeIds: Array.from({ length: MAX_TASK_ASSIGNEES + 1 }, (_, i) => `u${i}`),
      },
      { title: 'x', assigneeIds: ['u1'], description: 'd'.repeat(10_001) },
      { title: 'x', assigneeIds: ['u1'], dueDate: '2026-13-01' },
      { title: 'x', assigneeIds: ['u1'], dueDate: '2026-10-01T00:00:00Z' },
    ];
    for (const body of bad) {
      expect(CreateTaskRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

describe('UpdateTaskRequestSchema', () => {
  it('needs at least one field, and null clears the due date', () => {
    expect(UpdateTaskRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateTaskRequestSchema.parse({ dueDate: null })).toEqual({ dueDate: null });
    expect(UpdateTaskRequestSchema.safeParse({ assigneeIds: [] }).success).toBe(false);
  });
});

describe('move and confirm requests', () => {
  it('check status, position and the answer', () => {
    expect(MoveTaskRequestSchema.parse({ status: 'in_progress', position: 1.5 })).toEqual({
      status: 'in_progress',
      position: 1.5,
    });
    expect(MoveTaskRequestSchema.safeParse({ status: 'blocked', position: 1 }).success).toBe(false);
    expect(MoveTaskRequestSchema.safeParse({ status: 'todo', position: Infinity }).success).toBe(
      false,
    );
    expect(ConfirmTaskDoneRequestSchema.safeParse({ done: 'yes' }).success).toBe(false);
    expect(ConfirmTaskDoneRequestSchema.parse({ done: false })).toEqual({ done: false });
  });
});

describe('allowedTaskMoves', () => {
  it('lets leads move anywhere and assignees only between To do and In progress', () => {
    expect(allowedTaskMoves('done', { isLead: true, isAssignee: false })).toEqual([
      'todo',
      'in_progress',
      'in_review',
      'done',
    ]);
    expect(allowedTaskMoves('todo', { isLead: false, isAssignee: true })).toEqual([
      'todo',
      'in_progress',
    ]);
    expect(allowedTaskMoves('in_review', { isLead: false, isAssignee: true })).toEqual([]);
    expect(allowedTaskMoves('todo', { isLead: false, isAssignee: false })).toEqual([]);
  });
});

describe('TaskViewSchema', () => {
  it('parses a task', () => {
    const now = '2026-09-28T10:00:00.000Z';
    const task = {
      id: 't1',
      title: 'Login page',
      description: '',
      status: 'in_review',
      dueDate: '2026-10-01',
      position: 2,
      assignees: [{ id: 'u2', name: 'Mo' }],
      createdBy: { id: 'u1', name: 'Lee' },
      doneConfirmPending: true,
      reopenNote: null,
      linkedSubmissions: [{ id: 's1', title: 'Login', status: 'merged' }],
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      viewerActions: ['edit', 'move', 'delete', 'confirmDone'],
    };
    expect(TaskViewSchema.parse(task)).toEqual(task);
    expect(TaskViewSchema.safeParse({ ...task, viewerActions: ['approve'] }).success).toBe(false);
  });
});

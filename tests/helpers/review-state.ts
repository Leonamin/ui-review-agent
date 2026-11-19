import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {ReviewTask} from '../../src/review-contract.js';
import type {ReviewService} from '../../src/review-service.js';

export async function readStoredReviewTasks(service: Pick<ReviewService, 'stateRoot'>): Promise<ReviewTask[]> {
 const state = JSON.parse(await readFile(resolve(service.stateRoot, 'state.json'), 'utf8')) as {tasks: ReviewTask[]};
 return state.tasks;
}

export async function readStoredReviewTask(service: Pick<ReviewService, 'stateRoot'>, taskId: string): Promise<ReviewTask> {
 const task = (await readStoredReviewTasks(service)).find(task => task.taskId === taskId);
 assert.ok(task, `Persisted task is missing: ${taskId}`);
 return task;
}

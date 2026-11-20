import { isDeepStrictEqual } from 'node:util';
import type { ReviewRevision } from './review-contract.js';
import { convertWorkspaceState, type LegacyReviewState, type WorkspaceStateCandidate } from './workspace-state-converter.js';

// Project v2 onto the service's existing in-memory task view. Each request and
// its target reference the same attempts so the worker owns all transitions.
function projectCandidate(candidate: WorkspaceStateCandidate): LegacyReviewState {
    const { requests, ...workspaceMetadata } = candidate.workspaceData;
    const tasks = candidate.legacyTaskHeaders.map(header => ({ ...header, revisions: [] as ReviewRevision[] }));
    const taskIndex = new Map(tasks.map(task => [task.taskId, task]));
    const revisions = new Map<string, ReviewRevision>();
    const executions = [
        ...requests.map(request => ({ ...request, workspaceRequestId: request.requestId })),
        ...candidate.archivedExecutions.map(entry => ({ ...entry, workspaceRequestId: undefined })),
    ].sort((left, right) => left.execution.dispatchOrder - right.execution.dispatchOrder);

    for (const { execution, attempts, workspaceRequestId } of executions) {
        const { origin: { taskId, revisionId, targetId }, submission, target } = execution;
        let revision = revisions.get(revisionId);
        if (!revision) {
            revision = { ...submission, revisionId, workspaceRequestId, targets: [] };
            taskIndex.get(taskId)!.revisions.push(revision);
            revisions.set(revisionId, revision);
        }
        revision.targets.push({ ...target, targetId, attempts });
    }

    return {
        version: 1,
        tasks,
        workspaceData: {
            ...workspaceMetadata,
            requests: requests.map(({ execution, ...request }) => ({ ...request, ...execution.origin })),
        },
        assets: candidate.assets,
        submissions: Object.fromEntries(Object.entries(candidate.legacySubmissions).map(
            ([key, { requestId: _requestId, ...submission }]) => [key, submission],
        )),
        compatibleConnections: candidate.compatibleConnections,
        focusedReviews: candidate.focusedReviews,
        focusedSubmissions: candidate.focusedSubmissions,
    };
}

export function readWorkspaceStateCandidate(value: unknown): LegacyReviewState {
    try {
        const projected = projectCandidate(value as WorkspaceStateCandidate);
        // Apply the converter's checks and verify the derived ownership, order,
        // and cross-references before startup can write anything to disk.
        const { candidate } = convertWorkspaceState(projected);
        if (isDeepStrictEqual(JSON.parse(JSON.stringify(candidate)), value)) return projected;
    } catch {
        // A malformed or inconsistent candidate cannot start the service.
    }
    throw new Error('Invalid workspace state v2 candidate');
}

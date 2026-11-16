// Whether the end-to-end harness may stop the herdr-core that answers it:
// only when the person's own core is known (its pid) and the one answering
// is another. If HC_SESSION were ever ignored, the answer would be the
// person's core, and stopping it would end every terminal they have.
export const safeToStop = (status, defaultPid) => Boolean(status) && defaultPid !== null && status.pid !== defaultPid;

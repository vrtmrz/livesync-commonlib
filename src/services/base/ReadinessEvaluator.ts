/** One ordered condition in a readiness evaluation. */
export interface ReadinessCondition<TContext> {
    /** Stable diagnostic name for the condition; it is not user-facing text. */
    readonly name: string;
    /**
     * Return whether this condition applies to the current evaluation.
     *
     * Applicability checks must be side-effect-free. Conditions without this
     * callback always apply.
     */
    readonly appliesTo?: (context: TContext) => boolean;
    /** Return whether the condition admits the requested operation. */
    readonly evaluate: (context: TContext) => boolean | Promise<boolean>;
    /** Perform condition-specific reporting after a false result. */
    readonly onRejected?: (context: TContext) => void | Promise<void>;
}

/** A purpose and its ordered readiness conditions. */
export interface ReadinessEvaluationRequest<TContext> {
    /** Stable diagnostic purpose; it is not user-facing text. */
    readonly purpose: string;
    readonly context: TContext;
    readonly conditions: readonly ReadinessCondition<TContext>[];
}

/** Structured result from an ordered readiness evaluation. */
export type ReadinessEvaluationResult =
    | { readonly ready: true; readonly purpose: string }
    | { readonly ready: false; readonly purpose: string; readonly rejectedCondition: string };

/**
 * Evaluate applicable conditions in declaration order until one rejects.
 *
 * Rejection reporting completes before the result is returned. Exceptions
 * from applicability, evaluation, or reporting callbacks propagate unchanged;
 * the evaluator does not reinterpret operational failures as policy results.
 */
export async function evaluateReadiness<TContext>(
    request: ReadinessEvaluationRequest<TContext>
): Promise<ReadinessEvaluationResult> {
    for (const condition of request.conditions) {
        if (condition.appliesTo && !condition.appliesTo(request.context)) continue;
        if (await condition.evaluate(request.context)) continue;
        await condition.onRejected?.(request.context);
        return {
            ready: false,
            purpose: request.purpose,
            rejectedCondition: condition.name,
        };
    }
    return { ready: true, purpose: request.purpose };
}

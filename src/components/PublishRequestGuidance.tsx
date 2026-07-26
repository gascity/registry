import type { PublishRequestRow } from "../lib/api";
import {
  publishRequestPresentation,
  type PublishRequestAudience,
} from "../lib/publishRequestPresentation";

export function PublishRequestGuidance({
  request,
  audience = "publisher",
}: {
  request: PublishRequestRow;
  audience?: PublishRequestAudience;
}) {
  const presentation = publishRequestPresentation(request, audience);

  return (
    <div className="requestGuidance">
      <dl className="requestGuidanceMeta">
        <div>
          <dt>Submitted via</dt>
          <dd>{presentation.submission.label}</dd>
        </div>
        <div>
          <dt>Proof basis</dt>
          <dd>{presentation.proof.label}</dd>
        </div>
      </dl>
      <p className="requestGuidanceDetail">{presentation.proof.detail}</p>
      <p>
        <strong>What happens next:</strong> {presentation.nextStep}
      </p>
    </div>
  );
}

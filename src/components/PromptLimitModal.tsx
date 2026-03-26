import React from 'react';

interface PromptLimitModalProps {
  open: boolean;
  onClose: () => void;
}

export const PromptLimitModal: React.FC<PromptLimitModalProps> = ({ open, onClose }) => {
  if (!open) return null;

  return (
    <div className="sg-limit-overlay" onClick={onClose}>
      <div className="sg-limit-modal" onClick={e => e.stopPropagation()}>
        <div className="sg-limit-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="40" height="40">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          </svg>
        </div>
        <h2>Analysis Limit Reached</h2>
        <p>
          You've used all 4 complimentary analysis sessions included with your account.
          We hope the results demonstrated the depth of Stratageo's spatial intelligence.
        </p>
        <div className="sg-limit-cta">
          <p><strong>Want unlimited access?</strong></p>
          <p>Contact us to discuss enterprise plans tailored to your site selection needs.</p>
          <a
            href="mailto:info@stratageo.in?subject=Stratageo%20Portal%20-%20Interested%20in%20Unlimited%20Access"
            className="sg-limit-btn"
          >
            Contact Stratageo
          </a>
          <a
            href="https://stratageo.in"
            className="sg-limit-link"
            target="_blank"
            rel="noopener noreferrer"
          >
            Visit stratageo.in
          </a>
        </div>
        <button className="sg-limit-close" onClick={onClose}>&times;</button>
      </div>
    </div>
  );
};

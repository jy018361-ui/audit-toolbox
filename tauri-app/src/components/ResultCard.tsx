import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export type ResultCardProps = {
  title?: string;
  description?: string;
  children: ReactNode;
  empty?: ReactNode;
  footer?: ReactNode;
};

/**
 * 统一的结果展示卡片。取代分散的 .result-card / .kz-result / .confirmation-result。
 */
export function ResultCard({ title, description, children, empty, footer }: ResultCardProps) {
  const body = children ?? empty;
  if (body == null && empty == null) return null;
  return (
    <Card className="result-card">
      {(title || description) && (
        <CardHeader>
          {title && <CardTitle>{title}</CardTitle>}
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
      )}
      <CardContent>{body}</CardContent>
      {footer && <CardContent className="result-card-footer">{footer}</CardContent>}
    </Card>
  );
}

import type { ReactNode } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  type CardVariant,
} from "@/components/ui/card";

export type ResultCardProps = {
  title?: string;
  description?: string;
  children?: ReactNode;
  empty?: ReactNode;
  footer?: ReactNode;
  variant?: CardVariant;
  className?: string;
};

/**
 * 统一的结果展示卡片。取代分散的 .result-card / .kz-result / .confirmation-result。
 */
export function ResultCard({ title, description, children, empty, footer, variant = "section", className }: ResultCardProps) {
  const body = children ?? empty;
  if (body == null) return null;
  return (
    <Card variant={variant} className={`result-card-shared ${className ?? ""}`}>
      {(title || description) && (
        <CardHeader>
          {title && <CardTitle>{title}</CardTitle>}
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
      )}
      <CardContent>{body}</CardContent>
      {footer && <CardFooter className="result-card-footer">{footer}</CardFooter>}
    </Card>
  );
}

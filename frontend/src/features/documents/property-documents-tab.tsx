"use client";

import { RecordDocuments } from "./record-documents";

/** Documents tab for the property detail page. */
export function PropertyDocumentsTab({ propertyId }: { propertyId: string }) {
  return <RecordDocuments entityType="property" entityId={propertyId} />;
}

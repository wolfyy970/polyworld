/**
 * Lane W1b — overlays (native `proplib/overlay.{h,cc}`).
 *
 * An overlay is a block of the worldfile (or a separate document) whose scalar leaves are
 * *edits*: `SchemaDocument::apply` calls it before normalization, so an overlay can set a
 * value that the schema would otherwise default. Only const scalars can be overlaid
 * (native: "Only const scalars currently supported for overlays"), and the edited property
 * is named by the overlay property's full name at a fixed depth — 2 for an embedded
 * `overlay { … }` block, 3 for a `overlays[ i ] { … }` clause — which is exactly what
 * `getFullName( _depth )` produces.
 */

import type { DocumentEditor } from './editor';
import { ConstScalarProperty, Document, Property } from './dom';

export class Overlay {
  private depth = 1;

  /** Native `Overlay::applyDocument( overlay, editor )`. */
  applyDocument(overlay: Document, editor: DocumentEditor): void {
    this.depth = 1;
    this.apply(overlay, editor);
  }

  /** Native `Overlay::applyDocument( overlay, overlayIndex, editor )`. */
  applyDocumentIndex(overlay: Document, overlayIndex: number, editor: DocumentEditor): void {
    const overlays = overlay.requireProp('overlays');
    if (overlay.props().length > 1) overlay.err("Expecting only 'overlays' at top-level.");

    this.depth = 3;

    const overlayClause = overlays.requireProp(overlayIndex);
    if (overlayClause.getType() !== 'Object') overlayClause.err('Expecting Object');

    this.apply(overlayClause, editor);
  }

  /** Native `Overlay::applyEmbedded( doc, editor )`. */
  applyEmbedded(doc: Document, editor: DocumentEditor): void {
    const overlay = doc.requireProp('overlay');
    this.depth = 2;
    this.apply(overlay, editor);
  }

  /** Native `Overlay::getDocumentPropertyName( overlayProperty )`. */
  private getDocumentPropertyName(overlayProperty: Property): string {
    return overlayProperty.getFullName(this.depth);
  }

  /** Native `Overlay::apply( overlayProp, editor )`. */
  apply(overlayProp: Property, editor: DocumentEditor): void {
    if (overlayProp.getType() === 'Scalar') {
      if (overlayProp.getSubtype() !== 'Const') {
        overlayProp.err('Only const scalars currently supported for overlays');
      }

      const name = this.getDocumentPropertyName(overlayProp);
      const value = overlayProp instanceof ConstScalarProperty
        ? overlayProp.getExpression().toString()
        : overlayProp.scalarText();

      editor.set(name, value);
    } else {
      for (const child of overlayProp.props()) this.apply(child, editor);
    }
  }
}

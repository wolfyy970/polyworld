/**
 * Lane W1b — document editor (native `proplib/editor.{h,cc}`).
 *
 * The single mutation surface of the document model: the worldfile converter, the schema's
 * default injection, the parameter overrides (`--Vision False`) and the overlay all edit
 * through here, exactly as native does. Two behaviors are load-bearing for the output:
 *
 *   1. `set( prop, value )` builds a *new* property from the text and splices it in at the
 *      **old property's location**, so an overridden value keeps the source formatting of
 *      the node it replaced (this is why `  Vision False` in `normalized.wf` is indented
 *      like the schema's `  default True`, not like the command line).
 *   2. `replace` keeps the map position of the property it replaces, and `remove` erases by
 *      identifier, which is why a converted-away property leaves no trace in the output.
 *
 * PORT-NOTE(proplib/editor-err): native `editor.cc` has its own static `err( msg )` (message
 * only, no location, then `exit(1)`) for the "cannot find / only properties / cannot edit
 * runtime" failures; those keep the message-only form here, as `ProplibError`.
 */

import { DocumentBuilder } from './builder';
import { Document, DocumentLocation, Identifier, Property, __ContainerProperty } from './dom';
import type { SymbolPath } from './expression';
import { proplibError } from './error';
import type { SchemaDocument } from './schema';

/** Native `editor.cc`'s file-local `static void err( string msg )`. */
function err(message: string): never {
  return proplibError(message);
}

export class DocumentEditor {
  constructor(
    private readonly schema: SchemaDocument | undefined,
    private readonly doc: Document,
  ) {}

  /** Native `DocumentEditor::setMeta( name, value )`. */
  setMeta(name: string, value: string): void {
    const builder = new DocumentBuilder();
    this.doc.setMetaDirect(
      builder.buildMetaProperty(new DocumentLocation(this.doc), new Identifier(name), ` ${value}`),
    );
  }

  /**
   * Native `DocumentEditor::set( string symbolPathString, string valueString )` — the
   * symbol-path form, used by `--Param value` and by the overlay, and
   * `DocumentEditor::set( Property *, string )` — the direct form.
   */
  set(path: string, value: string): void;
  set(prop: Property, value: string): void;
  set(target: string | Property, value: string): void {
    if (typeof target !== 'string') {
      this.setProperty(target, value);
      return;
    }

    const builder = new DocumentBuilder();
    const symbolPath: SymbolPath = builder.buildSymbolPath(target);

    if (this.schema) this.schema.makePathDefaults(this.doc, symbolPath);

    const sym = this.doc.findSymbol(symbolPath);
    if (!sym) {
      if (this.schema) {
        err(`Cannot find ${target} in ${this.doc.getPath()} or ${this.schema.getPath()}`);
      }
      err(`Cannot find ${target} in ${this.doc.getPath()}`);
    }

    if (sym.type !== 'Property') err(`Only properties can be edited. (${target})`);

    this.setProperty(sym.prop, value);
  }

  /** Native `DocumentEditor::set( Property *prop, string valueString )`. */
  setProperty(prop: Property, value: string): void {
    if (prop.getSubtype() === 'Runtime') {
      err(`Runtime properties cannot be edited. (${prop.getFullName(1)})`);
    }

    const builder = new DocumentBuilder();
    const newProp = builder.buildProperty(prop.getLocation(), prop.getName(), ` ${value}`);

    const parent = prop.getParent();
    if (!(parent instanceof __ContainerProperty)) {
      prop.err(`Cannot replace '${prop.getName()}': it has no container parent.`);
    }
    parent.replace(newProp);
  }

  /** Native `DocumentEditor::move( prop, newParent, modifyOldParent )`. */
  move(prop: Property, newParent: Property): void {
    if (!(newParent instanceof __ContainerProperty)) {
      newParent.err('[Edit] Expecting Object or Array');
    }
    newParent.add(prop);
  }

  /** Native `DocumentEditor::remove( prop )`. */
  remove(prop: Property): void {
    const parent = prop.getParent();
    if (parent instanceof __ContainerProperty) parent.remove(prop);
  }

  /** Native `DocumentEditor::removeChildren( prop )`. */
  removeChildren(prop: Property): void {
    if (!(prop instanceof __ContainerProperty)) prop.err('Expecting Object or Array');
    prop.removeChildren();
  }

  /** Native `DocumentEditor::rename( prop, newName, modifyParent )`. */
  rename(prop: Property, newName: string): void {
    prop.renameId(newName);
  }
}

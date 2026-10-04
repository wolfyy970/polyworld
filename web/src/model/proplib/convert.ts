/**
 * Lane W1b — worldfile conversion (native `proplib/convert.{h,cc}`).
 *
 * Three jobs, all of them "make an old worldfile mean what a v2 worldfile means":
 *
 *   isV1 / convertV1SyntaxToV2          v1 (`WorldSize 100` …) → v2 syntax
 *   convertV1PropertiesToV2             v1 property *meanings* (quoting, conditionals,
 *                                       arrays, brain recording) → v2 properties
 *   convertDeprecatedV2Properties       v2 properties that v2 later deprecated
 *   setParameters                       `--Param value` command-line overrides
 *
 * Only the last two run for a `@version 2` worldfile, and `setParameters` is the one the
 * recorded scenarios exercise (`--Vision False`).
 *
 * PORT-NOTE(proplib/converter-streams): native `convertV1SyntaxToV2` reads `pathIn` and
 * writes `pathOut` (a `.v2` file next to the worldfile); the port returns the converted
 * text and leaves the writing to `cli.ts`, so nothing under `src/model/**` touches the
 * filesystem. The document identity (the `.v2` path) is preserved by the builder.
 *
 * PORT-NOTE(proplib/rawval-cast): native `RAWVAL(prop)` is
 * `dynamic_cast<ConstScalarProperty *>(prop)->getExpression()->toString(false)` — a null
 * dereference if the property is not a const scalar. The port raises a clear error instead
 * of dereferencing null; every property the macro is applied to is a const scalar in the
 * schema (`GenomeLayout`, `ComplexityType`, `EnergyUseMateMode`, `Name`, `FoodTypeName`).
 */

import type { DocumentEditor } from './editor';
import { ConstScalarProperty, Document, Property, propString } from './dom';
import { Tokenizer, tokenToString, type Token } from './lexer';

/** Native `RAWVAL( PROP )`: the property's *unevaluated* source text. */
function rawVal(prop: Property): string {
  if (!(prop instanceof ConstScalarProperty)) {
    prop.err('Expecting a const scalar property.');
  }
  return prop.getExpression().write(false);
}

export class WorldfileConverter {
  /** Native `WorldfileConverter::isV1( path )`: v1 files do not start with `@`. */
  isV1(source: string): boolean {
    return source.length === 0 || source[0] !== '@';
  }

  /** Native `WorldfileConverter::convertV1SyntaxToV2( pathIn, pathOut )`. */
  convertV1SyntaxToV2Text(source: string): string {
    const isObjectArray: boolean[] = [];
    const tokenizer = new Tokenizer('<v1>', source);

    let out = '@version 2\n';

    for (let tok: Token | undefined = tokenizer.next(); tok && tok.type !== 'Eof'; tok = tokenizer.next()) {
      if (tok.type === 'LeftSquare') {
        out += tokenToString(tok, tok, true);
        tok = tokenizer.next();

        switch (tok.type) {
          case 'RightSquare':
            break;
          case 'Number':
            isObjectArray.push(false);
            break;
          default:
            isObjectArray.push(true);
            out += ' { ';
            break;
        }

        out += tokenToString(tok, tok, true);
      } else if (tok.type === 'RightSquare') {
        if (isObjectArray[isObjectArray.length - 1]) {
          out += tok.getDecorationString();
          out += ' } ';
          out += tok.text;
        } else {
          out += tokenToString(tok, tok, true);
        }
        isObjectArray.pop();
      } else if (tok.type === 'Comma') {
        if (isObjectArray[isObjectArray.length - 1]) {
          out += tok.getDecorationString();
          out += ' } , { ';
        } else {
          out += tokenToString(tok, tok, true);
        }
      } else if (tok.type === 'Misc' && tok.text === '$') {
        out += ' ';
      } else if (tok.type === 'Misc' && tok.text === '\\"') {
        out += tok.getDecorationString();
        out += '"';
      } else {
        out += tokenToString(tok, tok, true);
      }
    }

    return out;
  }

  /** Native `WorldfileConverter::convertV1PropertiesToV2( editor, doc )`. */
  convertV1PropertiesToV2(editor: DocumentEditor, doc: Document): void {
    const remove = (container: Property, name: string): void => {
      const prop = container.getpProp(name);
      if (prop) editor.remove(prop);
    };

    const quote = (container: Property, name: string): void => {
      const prop = container.getpProp(name);
      if (prop) editor.set(prop, `"${rawVal(prop)}"`);
    };

    const setIf = (container: Property, name: string, oldValue: string, newValue: string): void => {
      const prop = container.getpProp(name);
      if (prop && propString(prop) === oldValue) editor.set(prop, newValue);
    };

    const conditionToDyn = (container: Property, name: string): void => {
      const prop = container.getpProp(name);
      if (!prop || prop.getType() !== 'Object') return;

      const conditions = prop.requireProp('Conditions');
      if (conditions.size() > 1) conditions.err('Cannot auto convert multiple conditions');

      editor.remove(prop);

      const value = conditions.requireProp(0).requireProp('Value');
      editor.rename(value, name);
      editor.move(value, container);
    };

    // --- Monitor -----------------------------------------------------------------------
    for (const name of [
      'AgentTracking',
      'BrainMonitorFrequency',
      'CameraAngleStart',
      'CameraColor',
      'CameraFieldOfView',
      'CameraHeight',
      'CameraRadius',
      'CameraRotationRate',
      'ChartBorn',
      'ChartFitness',
      'ChartFoodEnergy',
      'ChartGeneSeparation',
      'ChartPopulation',
      'MonitorAgentRank',
      'MonitorGeneSeparation',
      'OverHeadRank',
      'ShowVision',
      'StatusFrequency',
      'StatusToStdout',
    ]) {
      remove(doc, name);
    }

    // --- Logging -----------------------------------------------------------------------
    remove(doc, 'RecordFoodPatchStats');
    remove(doc, 'RecordMovie');
    remove(doc, 'RecordGeneSeparation');
    remove(doc, 'RecordPerformanceStats');
    setIf(doc, 'RecordPosition', 'True', 'Precise');
    setIf(doc, 'RecordSeparations', 'True', 'Contact');

    // --- Conditionals ------------------------------------------------------------------
    for (const name of [
      'EatMateMinDistance',
      'MaxEatVelocity',
      'MaxEatYaw',
      'MaxMateVelocity',
      'MinEatVelocity',
    ]) {
      conditionToDyn(doc, name);
    }
    {
      const prop = doc.getpProp('EnergyUseMateMode');
      if (prop && rawVal(prop) !== 'Constant') prop.err('Cannot auto convert conditional');
    }
    remove(doc, 'EnergyUseMateConditional');
    remove(doc, 'EnergyUseMateMode');

    // --- Misc --------------------------------------------------------------------------
    quote(doc, 'ComplexityType');
    remove(doc, 'StickyEdges');
    remove(doc, 'WrapAround');

    // --- AgentMetabolisms --------------------------------------------------------------
    {
      const metabolisms = doc.getpProp('AgentMetabolisms');
      if (metabolisms) {
        for (const metabolism of metabolisms.props()) {
          conditionToDyn(metabolism, 'EatMultiplier');
          conditionToDyn(metabolism, 'MinEatAge');
          quote(metabolism, 'CarcassFoodTypeName');
          quote(metabolism, 'Name');
        }
      }
    }

    // --- Barriers ----------------------------------------------------------------------
    {
      const barriers = doc.getpProp('Barriers');
      if (barriers) {
        for (const barrier of barriers.props()) {
          const keyframes = barrier.getpProp('KeyFrames');
          if (keyframes) {
            if (keyframes.size() > 1) keyframes.err('Cannot auto convert');
            editor.removeChildren(barrier);

            const keyframe0 = keyframes.requireProp(0);
            for (const coord of keyframe0.props()) {
              const name = coord.getName();
              if (name.length > 0 && (name[0] === 'X' || name[0] === 'Z')) {
                editor.move(coord, barrier);
              }
            }
          }
        }
      }
    }

    // --- Domains -----------------------------------------------------------------------
    {
      const domains = doc.getpProp('Domains');
      if (domains) {
        for (const domain of domains.props()) {
          const foodPatches = domain.getpProp('FoodPatches');
          if (foodPatches) {
            for (const patch of foodPatches.props()) {
              quote(patch, 'FoodTypeName');
              remove(patch, 'OnCondition');
            }
          }
        }
      }
    }

    // --- FoodTypes ---------------------------------------------------------------------
    {
      const foodTypes = doc.getpProp('FoodTypes');
      if (foodTypes) {
        for (const foodType of foodTypes.props()) quote(foodType, 'Name');
      }
    }

    // --- Brain recording ---------------------------------------------------------------
    {
      remove(doc, 'BrainAnatomyRecordSeeds');
      remove(doc, 'BrainFunctionRecordSeeds');

      {
        let setRecordBrain = false;
        let recordBrain = false;

        for (const name of ['BrainAnatomyRecordAll', 'BrainFunctionRecordAll']) {
          const prop = doc.getpProp(name);
          if (prop) {
            setRecordBrain = true;
            recordBrain = recordBrain || propString(prop) === 'True' || propString(prop) === '1';
            editor.remove(prop);
          }
        }

        if (setRecordBrain) editor.set('RecordBrain', 'True');
      }

      {
        let setFrequency = false;
        let frequency = '';
        const record = new Map<string, boolean>();

        const setFrequencyFor = (oldPropName: string, recordName: string): void => {
          const prop = doc.getpProp(oldPropName);
          if (!prop) return;

          const freq = propString(prop);
          if (
            frequency.length > 0 &&
            freq !== '0' &&
            frequency !== '0' &&
            freq !== frequency
          ) {
            prop.err('Found different non-zero brain record frequencies!');
          }
          if (freq !== '0') {
            setFrequency = true;
            frequency = freq;
          }
          record.set(recordName, (record.get(recordName) ?? false) || freq !== '0');
          editor.remove(prop);
        };

        setFrequencyFor('BrainFunctionRecentRecordFrequency', 'RecordBrainRecent');
        setFrequencyFor('BestRecentBrainAnatomyRecordFrequency', 'RecordBrainBestRecent');
        setFrequencyFor('BestRecentBrainFunctionRecordFrequency', 'RecordBrainBestRecent');
        setFrequencyFor('BestSoFarBrainAnatomyRecordFrequency', 'RecordBrainBestSoFar');
        setFrequencyFor('BestSoFarBrainFunctionRecordFrequency', 'RecordBrainBestSoFar');

        if (setFrequency) editor.set('EpochFrequency', frequency);

        for (const [name, value] of record) editor.set(name, value ? 'True' : 'False');
      }
    }
  }

  /** Native `WorldfileConverter::convertDeprecatedV2Properties( editor, doc )`. */
  convertDeprecatedV2Properties(editor: DocumentEditor, doc: Document): void {
    const remove = (container: Property, name: string): void => {
      const prop = container.getpProp(name);
      if (prop) editor.remove(prop);
    };

    const setIfRaw = (container: Property, name: string, oldValue: string, newValue: string): void => {
      const prop = container.getpProp(name);
      if (prop && rawVal(prop) === oldValue) editor.set(prop, newValue);
    };

    remove(doc, 'MinBiasLrate');
    remove(doc, 'MaxBiasLrate');

    setIfRaw(doc, 'GenomeLayout', 'L', 'None');
    setIfRaw(doc, 'GenomeLayout', 'N', 'NeurGroup');

    // --- LegacyMode --------------------------------------------------------------------
    {
      const legacy = doc.getpProp('LegacyMode');
      if (legacy) {
        if (propString(legacy) === 'True' || propString(legacy) === '1') {
          editor.setMeta('@defaults', 'legacy');
        }
        editor.remove(legacy);
      }
    }

    // --- FoodTypes ---------------------------------------------------------------------
    {
      const foodTypes = doc.getpProp('FoodTypes');
      if (foodTypes) {
        for (const foodType of foodTypes.props()) {
          const overrideColor = foodType.getpProp('OverrideFoodColor');
          if (overrideColor) {
            if (!(propString(overrideColor) === 'True' || propString(overrideColor) === '1')) {
              remove(foodType, 'FoodColor');
            }
            editor.remove(overrideColor);
          }
        }
      }
    }

    // --- Domains -----------------------------------------------------------------------
    {
      const domains = doc.getpProp('Domains');
      if (domains) {
        for (const domain of domains.props()) {
          const brickPatches = domain.getpProp('BrickPatches');
          if (brickPatches) {
            for (const patch of brickPatches.props()) {
              const overrideColor = patch.getpProp('OverrideBrickColor');
              if (overrideColor) {
                if (!(propString(overrideColor) === 'True' || propString(overrideColor) === '1')) {
                  remove(patch, 'BrickColor');
                }
                editor.remove(overrideColor);
              }
            }
          }
        }
      }
    }
  }

  /** Native `WorldfileConverter::setParameters( editor, parameters )`. */
  setParameters(editor: DocumentEditor, parameters: ReadonlyMap<string, string>): void {
    for (const [key, value] of parameters) editor.set(key, value);
  }
}

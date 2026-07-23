// Host import for executing neural network inference on the proxy side (using ONNX runtime)
declare function runOnnxInference(modelName: string, inputData: Float32Array): Float32Array;

// Vocabulary mapping of tool names to vocab indices (18 unique tokens)
const TOOL_VOCAB = new Map<string, i32>();

function initVocab(): void {
  if (TOOL_VOCAB.size > 0) return;
  TOOL_VOCAB.set("read_file", 0);
  TOOL_VOCAB.set("write_file", 1);
  TOOL_VOCAB.set("view_file", 2);
  TOOL_VOCAB.set("replace_file_content", 3);
  TOOL_VOCAB.set("multi_replace_file_content", 4);
  TOOL_VOCAB.set("list_dir", 5);
  TOOL_VOCAB.set("run_command", 6);
  TOOL_VOCAB.set("grep_search", 7);
  TOOL_VOCAB.set("search_web", 8);
  TOOL_VOCAB.set("read_url_content", 9);
  TOOL_VOCAB.set("browser_subagent", 10);
  TOOL_VOCAB.set("ask_permission", 11);
  TOOL_VOCAB.set("ask_question", 12);
  TOOL_VOCAB.set("send_message", 13);
  TOOL_VOCAB.set("invoke_subagent", 14);
  TOOL_VOCAB.set("manage_subagents", 15);
  TOOL_VOCAB.set("manage_task", 16);
  TOOL_VOCAB.set("schedule", 17);
}

/**
 * Normalizes a sequence of tool calls into a flat Float32Array suitable for ONNX input.
 * Input sequence is padded/truncated to seq_len=10, with one-hot vector representation of vocab_size=18.
 * Flattened array size: 10 * 18 = 180 floats.
 */
export function prepareInputSequence(toolSequence: string[]): Float32Array {
  initVocab();
  const seqLen = 10;
  const vocabSize = 18;
  const inputVector = new Float32Array(seqLen * vocabSize);

  // Pad or truncate toolSequence to match exactly seqLen elements
  const limit = Math.min(toolSequence.length, seqLen) as i32;
  
  for (let i = 0; i < limit; i++) {
    const toolName = toolSequence[i];
    let vocabIdx = -1;
    if (TOOL_VOCAB.has(toolName)) {
      vocabIdx = TOOL_VOCAB.get(toolName);
    }
    
    // If tool is found in vocabulary, set one-hot value to 1.0
    if (vocabIdx >= 0 && vocabIdx < vocabSize) {
      inputVector[i * vocabSize + vocabIdx] = 1.0;
    }
  }

  return inputVector;
}

/**
 * Calculates the Reconstruction Error (Mean Squared Error) between the input and reconstructed sequence.
 * If MSE > threshold (0.35), the sequence is flagged as anomalous.
 */
export function evaluateSequenceAnomaly(toolSequence: string[]): boolean {
  if (toolSequence.length < 3) {
    // Too short to reliably flag as sequence anomalies
    return false;
  }

  const inputVector = prepareInputSequence(toolSequence);
  
  // Clone input to preserve original values before inference mutation
  const originalVector = new Float32Array(inputVector.length);
  for (let i = 0; i < inputVector.length; i++) {
    originalVector[i] = inputVector[i];
  }

  // Call host-provided ONNX inference
  const reconstructedVector = runOnnxInference("anomaly_autoencoder", inputVector);

  if (reconstructedVector.length != originalVector.length) {
    // Gracefully handle model dimensions mismatch
    return false;
  }

  // Calculate Mean Squared Error (MSE)
  let sumSquaredError: f32 = 0.0;
  for (let i = 0; i < originalVector.length; i++) {
    const diff = originalVector[i] - reconstructedVector[i];
    sumSquaredError += diff * diff;
  }

  const mse = sumSquaredError / (inputVector.length as f32);
  const threshold: f32 = 0.35; // Calibrated reconstruction error threshold

  return mse > threshold;
}
